import { schedules, task, metadata } from "@trigger.dev/sdk/v3";
import { fetchAnalyticsReport } from "../lib/zoho-analytics.js";
import { searchZillowUrl, scrapeZillowProperty, preprocessSearchAddress } from "../lib/zillow.js";
import { getFullRecord, getRecordFields, listModuleFields, searchRecordIdByEmail, updateRecord } from "../lib/zoho.js";
import {
  writePropertyReport,
  appendWeeklySummary,
  type PropertyReportRow,
} from "../lib/google-sheets.js";
import { postAutomationReport } from "../lib/slack.js";
import { pickBusinessHourDate } from "../lib/scheduling.js";

// Concurrency-limited parallel execution helper with optional stagger delay
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  staggerMs = 0,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      // Stagger delay between items to avoid burst traffic
      if (staggerMs > 0 && i >= concurrency) {
        await new Promise((resolve) =>
          setTimeout(resolve, staggerMs + Math.random() * staggerMs)
        );
      }
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

type PropertyRecord = {
  orderId: string;
  displayName: string;
  city: string;
  state: string;
  currentStatus: string;
  statusUpdatedDate: string;
  zillowUrl: string;
};

// Inline property check — processes a single property and updates Zoho CRM
async function checkPropertyInline(payload: PropertyRecord & { rowIndex: number }): Promise<PropertyReportRow> {
  const {
    orderId,
    displayName,
    city,
    state,
    currentStatus,
    statusUpdatedDate,
    zillowUrl: existingUrl,
    rowIndex,
  } = payload;

  try {
    let url: string | null = null;
    let confidence: "high" | "medium" | "low" | null = null;
    let matchScore = 0;
    let matchFlags: string[] = [];

    // Skip SERP search if we already have a Zillow URL from Zoho
    if (existingUrl && existingUrl.includes("zillow.com/homedetails/")) {
      url = existingUrl;
      confidence = "high";
      matchScore = 11;
      matchFlags = ["CACHED_URL"];
      console.log(`[${rowIndex}] Using cached URL: ${url}`);
    } else {
      // Preprocess address: normalize case, strip zips, deduplicate city/state
      const { searchAddress, validationAddress } = preprocessSearchAddress(displayName, city, state);
      console.log(`[${rowIndex}] Searching: ${searchAddress}`);

      const searchResult = await searchZillowUrl(searchAddress, validationAddress);

      if (!searchResult.url) {
        console.log(`[${rowIndex}] No Zillow URL found`);
        return {
          orderId,
          displayName,
          city,
          state,
          currentStatus,
          statusUpdatedDate,
          zillowUrl: null,
          zillowStatus: null,
          listPrice: null,
          bedrooms: null,
          bathrooms: null,
          squareFeet: null,
          confidence: null,
          matchScore: searchResult.matchScore,
          matchFlags: searchResult.matchFlags,
          error: searchResult.error || "No Zillow listing found",
          pendingEmailScheduled: false,
          pendingEmailScheduledFor: null,
        };
      }

      url = searchResult.url;
      confidence = searchResult.confidence;
      matchScore = searchResult.matchScore;
      matchFlags = searchResult.matchFlags;
      console.log(
        `[${rowIndex}] Found: ${url} (${confidence}, ${matchScore}/${searchResult.matchMaxScore})`
      );
    }

    // Scrape property details
    const propertyData = await scrapeZillowProperty(url);

    // Post-scrape address validation: verify scraped URL still matches input house number
    if (propertyData.url && propertyData.url.includes("/homedetails/")) {
      const scrapedHouseNum = propertyData.url.match(/\/homedetails\/(\d+)-/);
      const inputHouseNum = displayName.match(/^(\d+)\s/);
      if (scrapedHouseNum && inputHouseNum && scrapedHouseNum[1] !== inputHouseNum[1]) {
        console.log(`[${rowIndex}] Post-scrape rejection: scraped #${scrapedHouseNum[1]} != input #${inputHouseNum[1]}`);
        return {
          orderId, displayName, city, state, currentStatus, statusUpdatedDate,
          zillowUrl: null, zillowStatus: null, listPrice: null, bedrooms: null,
          bathrooms: null, squareFeet: null, confidence: null, matchScore: 0,
          matchFlags: ["POST_SCRAPE_HOUSE_NUM_MISMATCH"],
          error: `Scraper returned wrong property (#${scrapedHouseNum[1]} vs input #${inputHouseNum[1]})`,
          pendingEmailScheduled: false,
          pendingEmailScheduledFor: null,
        };
      }
    }

    // Downgrade confidence for sold listings (often show different property)
    if (propertyData.status === "Sold" && confidence === "high" && !matchFlags.includes("CACHED_URL")) {
      console.log(`[${rowIndex}] Downgrading confidence: status is Sold`);
      confidence = "medium";
    }

    let pendingEmailScheduled = false;
    let pendingEmailScheduledFor: string | null = null;

    // Update Zoho CRM for high-confidence matches
    if (confidence === "high" && orderId) {
      try {
        const updateData: Record<string, unknown> = {
          Zillow_URL: propertyData.url,
        };
        if (propertyData.price !== null) {
          updateData.List_Price = propertyData.price;
        }
        if (propertyData.bedrooms !== null) {
          updateData.Bedrooms = propertyData.bedrooms;
        }
        if (propertyData.bathrooms !== null) {
          updateData.Bathrooms = propertyData.bathrooms;
        }
        if (propertyData.squareFeet !== null) {
          updateData.Square_Feet = propertyData.squareFeet;
        }
        if (propertyData.status) {
          updateData.Property_Status = propertyData.status;
          updateData.Property_Status_Updated = propertyData.statusDate || new Date().toISOString().split("T")[0];
        }

        const updated = await updateRecord(orderId, updateData);
        if (updated) {
          console.log(`[${rowIndex}] Zoho CRM updated for record ${orderId}`);
        } else {
          console.log(`[${rowIndex}] Zoho CRM update failed for record ${orderId}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error(`[${rowIndex}] Zoho CRM update error for ${orderId}: ${msg}`);
        // Don't fail the whole property check if CRM update fails
      }

      // Schedule SST_Pending_Email_Offer stamp for "new pendings" — properties
      // that just hit Pending, haven't had this field populated yet, and have
      // NOT already ordered HSLP (we don't want to email a seller about
      // ordering HSLP if they've already ordered it). The stamp itself
      // triggers an outbound seller email in Zoho, so we delay each one to a
      // random business-hours moment over the next ~36h to avoid a flood.
      if (propertyData.status === "Pending") {
        try {
          const fields = await getRecordFields(orderId, [
            "SST_Pending_Email_Offer",
            "HSLP_upsell_purchased_at",
          ]);
          if (fields.HSLP_upsell_purchased_at) {
            console.log(
              `[${rowIndex}] HSLP_upsell_purchased_at already populated for ${orderId} (${fields.HSLP_upsell_purchased_at}) — skipping pending email offer`
            );
          } else if (fields.SST_Pending_Email_Offer) {
            console.log(
              `[${rowIndex}] SST Pending Email Offer already populated for ${orderId} (${fields.SST_Pending_Email_Offer}) — skipping`
            );
          } else {
            const fireAt = pickBusinessHourDate({ windowHours: 36 });
            const handle = await updatePendingEmailOffer.trigger(
              { orderId },
              { delay: fireAt }
            );
            pendingEmailScheduled = true;
            pendingEmailScheduledFor = fireAt.toISOString();
            console.log(
              `[${rowIndex}] Scheduled SST Pending Email Offer for ${orderId} at ${pendingEmailScheduledFor} (run ${handle.id})`
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error(
            `[${rowIndex}] Failed to schedule pending email offer for ${orderId}: ${msg}`
          );
        }
      }
    }

    const scrapeError =
      propertyData.error ||
      (!propertyData.status && !propertyData.price && !propertyData.bedrooms
        ? "Scrape returned no data (likely blocked)"
        : null);

    return {
      orderId,
      displayName,
      city,
      state,
      currentStatus,
      statusUpdatedDate,
      zillowUrl: propertyData.url,
      zillowStatus: propertyData.status,
      listPrice: propertyData.price,
      bedrooms: propertyData.bedrooms,
      bathrooms: propertyData.bathrooms,
      squareFeet: propertyData.squareFeet,
      confidence,
      matchScore,
      matchFlags,
      error: scrapeError,
      pendingEmailScheduled,
      pendingEmailScheduledFor,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`[${rowIndex}] Error: ${errorMessage}`);
    return {
      orderId,
      displayName,
      city,
      state,
      currentStatus,
      statusUpdatedDate,
      zillowUrl: null,
      zillowStatus: null,
      listPrice: null,
      bedrooms: null,
      bathrooms: null,
      squareFeet: null,
      confidence: null,
      matchScore: 0,
      matchFlags: [],
      error: errorMessage,
      pendingEmailScheduled: false,
      pendingEmailScheduledFor: null,
    };
  }
}

// One-off probe to discover the actual Zoho API names of HSLP-related fields.
// Optionally accepts a known orderId to also fetch a full record and confirm
// the field exists in record payloads.
export const probeHslpFields = task({
  id: "probe-hslp-fields",
  run: async (payload: { orderId?: string; email?: string } = {}) => {
    let hslpFields: Array<{
      api_name: string;
      field_label: string;
      data_type: string;
    }> = [];

    // Resolve email → orderId via Zoho's search API if we were given email
    // instead of (or in addition to) an orderId.
    let orderId = payload.orderId;
    if (!orderId && payload.email) {
      console.log(`Searching for record by email: ${payload.email}`);
      orderId = (await searchRecordIdByEmail(payload.email)) || undefined;
      console.log(`  → orderId = ${orderId || "(not found)"}`);
    }

    // Only call the settings/fields endpoint when we have no orderId — that
    // endpoint requires the ZohoCRM.settings.fields.READ scope which our
    // token may not have. The full-record path uses the core CRM read scope
    // that we know works.
    if (!orderId) {
      console.log("=== Listing all field metadata for the configured module ===");
      const fields = await listModuleFields();
      hslpFields = fields.filter(
        (f) =>
          f.api_name.toLowerCase().includes("hslp") ||
          f.field_label.toLowerCase().includes("hslp")
      );
      console.log(`Found ${hslpFields.length} HSLP-related fields:`);
      for (const f of hslpFields) {
        console.log(
          `  api_name="${f.api_name}"  label="${f.field_label}"  type=${f.data_type}`
        );
      }
    }

    let recordSample: Record<string, unknown> | null = null;
    let recordHslpKeys: string[] = [];
    if (orderId) {
      console.log(`=== Fetching full record ${orderId} ===`);
      recordSample = await getFullRecord(orderId);
      if (recordSample) {
        recordHslpKeys = Object.keys(recordSample).filter((k) =>
          k.toLowerCase().includes("hslp")
        );
        console.log(`HSLP-named keys in record: ${recordHslpKeys.join(", ") || "(none)"}`);
        for (const k of recordHslpKeys) {
          console.log(`  ${k} = ${JSON.stringify(recordSample[k])}`);
        }
      } else {
        console.log("Record not found");
      }
    }

    // Exercise the exact code path the gate uses to confirm the fix works.
    let gateCheck: Record<string, string | null> | null = null;
    if (orderId) {
      console.log(`=== Gate check via getRecordFields for ${orderId} ===`);
      gateCheck = await getRecordFields(orderId, [
        "SST_Pending_Email_Offer",
        "HSLP_upsell_purchased_at",
      ]);
      console.log(`Gate check result: ${JSON.stringify(gateCheck)}`);
      console.log(
        `Would the gate now SKIP? ${
          gateCheck["HSLP_upsell_purchased_at"] || gateCheck["SST_Pending_Email_Offer"]
            ? "YES (correctly)"
            : "NO (would schedule)"
        }`
      );
    }

    return {
      hslpFieldMetadata: hslpFields,
      recordHslpKeys,
      recordHslpValues: recordSample
        ? Object.fromEntries(recordHslpKeys.map((k) => [k, recordSample![k]]))
        : null,
      gateCheck,
    };
  },
});

// Delayed updater that stamps SST_Pending_Email_Offer with the time the task
// fires. We schedule one of these per "new pending" property with a random delay
// inside business hours (8am–6pm Central) so that the resulting Zoho-driven
// emails to sellers don't all blast out at once.
export const updatePendingEmailOffer = task({
  id: "update-pending-email-offer",
  run: async (payload: { orderId: string }) => {
    const { orderId } = payload;

    // Defense-in-depth re-check: the parent task already gated on
    // HSLP_upsell_purchased_at + SST_Pending_Email_Offer being empty, but state may
    // have changed during the random business-hours delay (HSLP may have been
    // ordered, or another run may have stamped SST). Re-check immediately
    // before writing so we never email a seller who has already ordered HSLP.
    try {
      const fields = await getRecordFields(orderId, [
        "SST_Pending_Email_Offer",
        "HSLP_upsell_purchased_at",
      ]);
      if (fields.HSLP_upsell_purchased_at) {
        console.log(
          `Skipping ${orderId}: HSLP_upsell_purchased_at now populated (${fields.HSLP_upsell_purchased_at})`
        );
        return { orderId, skipped: "HSLP_upsell_purchased_at_populated" };
      }
      if (fields.SST_Pending_Email_Offer) {
        console.log(
          `Skipping ${orderId}: SST_Pending_Email_Offer already populated (${fields.SST_Pending_Email_Offer})`
        );
        return { orderId, skipped: "SST_already_populated" };
      }
    } catch (err) {
      // If the re-check itself fails, do NOT stamp — failing closed is safer
      // than risking another wrong email.
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `Aborting stamp for ${orderId}: re-check fetch failed (${msg})`
      );
      throw new Error(`Pre-stamp re-check failed for ${orderId}: ${msg}`);
    }

    // ISO 8601 with timezone offset, no millis (Zoho doesn't accept millis)
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const updated = await updateRecord(orderId, {
      SST_Pending_Email_Offer: ts,
    });
    if (!updated) {
      throw new Error(
        `Failed to update SST_Pending_Email_Offer for ${orderId}`
      );
    }
    console.log(`Stamped SST_Pending_Email_Offer=${ts} on ${orderId}`);
    return { orderId, stampedAt: ts };
  },
});

// Batch worker — processes a slice of the full record list
// Runs as a parallel sub-task spawned by the coordinator
export const propertyBatchWorker = task({
  id: "property-batch-worker",
  run: async (payload: {
    records: PropertyRecord[];
    batchIndex: number;
    totalBatches: number;
    globalOffset: number; // used for consistent row numbering across batches
  }): Promise<PropertyReportRow[]> => {
    const { records, batchIndex, totalBatches, globalOffset } = payload;
    console.log(`[Batch ${batchIndex + 1}/${totalBatches}] Starting ${records.length} records`);

    let processedCount = 0;
    const results = await withConcurrency(
      records.map((record, idx) => ({ ...record, rowIndex: globalOffset + idx + 1 })),
      20, // 20 concurrent workers per batch (80 total across 4 batches)
      async (record) => {
        const result = await checkPropertyInline(record);
        processedCount++;
        if (processedCount % 200 === 0 || processedCount === records.length) {
          console.log(`[Batch ${batchIndex + 1}/${totalBatches}] ${processedCount}/${records.length}`);
        }
        return result;
      },
      500, // 500ms stagger to avoid anti-bot
    );

    const high = results.filter(r => r.confidence === "high").length;
    const errors = results.filter(r => r.error).length;
    console.log(`[Batch ${batchIndex + 1}/${totalBatches}] Done — ${high} high confidence, ${errors} errors`);
    return results;
  },
});

// Helper to run the full report using parallel batches
async function runReport(records: PropertyRecord[]) {
  const NUM_BATCHES = 8;
  const batchSize = Math.ceil(records.length / NUM_BATCHES);
  console.log(`Splitting ${records.length} records into ${NUM_BATCHES} parallel batches of ~${batchSize}`);

  // Trigger all batches simultaneously and wait for all to finish
  const batchResult = await propertyBatchWorker.batchTriggerAndWait(
    Array.from({ length: NUM_BATCHES }, (_, i) => ({
      payload: {
        records: records.slice(i * batchSize, (i + 1) * batchSize),
        batchIndex: i,
        totalBatches: NUM_BATCHES,
        globalOffset: i * batchSize,
      },
    }))
  );

  // Aggregate results from all batches (preserve original order)
  const allResults: PropertyReportRow[] = [];
  for (const run of batchResult.runs) {
    if (run.ok && run.output) {
      allResults.push(...run.output);
    } else {
      console.error(`Batch run failed: ${JSON.stringify(run)}`);
    }
  }

  return allResults;
}

// Build the status-breakdown stats and post a Slack summary to #automation-reports.
// "New status updates" = any high-confidence result whose Zillow status differs
// from the property's currentStatus in Zoho (case-insensitive match).
async function postRunSummary(
  totalChecked: number,
  results: PropertyReportRow[],
  spreadsheetUrl: string | null,
  spreadsheetError: string | null = null,
  recordWeekly: boolean = false
): Promise<void> {
  const highConfidence = results.filter((r) => r.confidence === "high").length;
  const reviewQueue = results.filter((r) => r.confidence !== "high").length;
  const highPct =
    totalChecked > 0 ? Math.round((highConfidence / totalChecked) * 100) : 0;
  const statusBreakdown = new Map<string, number>();
  let totalStatusUpdates = 0;
  for (const r of results) {
    if (r.confidence !== "high") continue;
    if (!r.zillowStatus) continue;
    const current = (r.currentStatus || "").trim().toLowerCase();
    const zillow = r.zillowStatus.trim().toLowerCase();
    if (current === zillow) continue;
    statusBreakdown.set(
      r.zillowStatus,
      (statusBreakdown.get(r.zillowStatus) || 0) + 1
    );
    totalStatusUpdates++;
  }

  const newPendings = results.filter((r) => r.pendingEmailScheduled).length;

  try {
    await postAutomationReport({
      totalChecked,
      highConfidence,
      totalStatusUpdates,
      statusBreakdown,
      newPendings,
      spreadsheetUrl,
      spreadsheetError,
    });
    console.log(
      `Slack summary posted — checked=${totalChecked}, high=${highConfidence}, status updates=${totalStatusUpdates}, new pendings=${newPendings}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to post Slack summary: ${msg}`);
  }

  // Append a persistent week-over-week row (scheduled runs only, so manual
  // test runs don't pollute the history).
  if (recordWeekly) {
    const now = new Date();
    const runDate = `${now.getMonth() + 1}/${now.getDate()}/${String(now.getFullYear()).slice(2)}`;
    await appendWeeklySummary({
      runDate,
      totalChecked,
      highConfidence,
      highPct,
      reviewQueue,
      totalStatusUpdates,
      statusBreakdown,
      newPendings,
      spreadsheetError,
    });
  }
}

// Main scheduled task — every Monday at 6 AM Central Time
export const zillowNonPcReport = schedules.task({
  id: "zillow-non-pc-report",
  cron: { pattern: "0 6 * * 1", timezone: "America/Chicago" },
  run: async () => {
    console.log("Starting non-PC Zillow property status report...");

    // Step 1: Fetch report from Zoho Analytics
    const records = await fetchAnalyticsReport();
    console.log(`Fetched ${records.length} records from Zoho Analytics`);

    if (records.length === 0) {
      return { status: "completed", message: "No records in report", processed: 0 };
    }

    metadata.set("totalRecords", records.length);
    metadata.set("status", "processing");

    // Step 2: Process all properties across 4 parallel batches
    const allResults = await runReport(records);

    // Step 3: Split results by confidence
    const highConfidence = allResults.filter(r => r.confidence === "high");
    const reviewQueue = allResults.filter(r => r.confidence !== "high");
    const crmUpdated = highConfidence.filter(r => r.orderId && r.zillowUrl).length;

    console.log(`Results: ${highConfidence.length} high confidence, ${reviewQueue.length} for review, ${crmUpdated} CRM records updated`);

    // Step 4: Write to Google Spreadsheet. Isolated in try/catch so a sheet
    // failure (e.g. the 10M-cell limit) never suppresses the Slack summary.
    let spreadsheetUrl: string | null = null;
    let spreadsheetError: string | null = null;
    try {
      spreadsheetUrl = await writePropertyReport(highConfidence, reviewQueue);
    } catch (err) {
      spreadsheetError = err instanceof Error ? err.message : "Unknown error";
      console.error(`Spreadsheet write failed (continuing to Slack): ${spreadsheetError}`);
    }

    const summary = {
      status: "completed",
      totalRecords: records.length,
      highConfidence: highConfidence.length,
      reviewQueue: reviewQueue.length,
      crmUpdated,
      noMatch: allResults.filter(r => !r.zillowUrl).length,
      withErrors: allResults.filter(r => r.error).length,
      spreadsheetUrl,
      spreadsheetError,
    };

    metadata.set("status", "completed");
    metadata.set("crmUpdated", crmUpdated);
    metadata.set("spreadsheetUrl", spreadsheetUrl);

    // Step 5: Slack summary + persistent weekly-summary row. Always runs, even
    // if the spreadsheet write failed.
    await postRunSummary(records.length, allResults, spreadsheetUrl, spreadsheetError, true);

    console.log(`Report complete: ${summary.highConfidence} high, ${summary.reviewQueue} review, ${summary.crmUpdated} CRM updated`);
    console.log(`Spreadsheet: ${spreadsheetUrl ?? "(write failed)"}`);

    return summary;
  },
});

// Manual trigger for testing — supports maxRecords limit and optional batch count
export const manualNonPcReport = task({
  id: "manual-non-pc-report",
  run: async (payload: { maxRecords?: number; numBatches?: number; recordWeekly?: boolean }) => {
    console.log("Starting manual non-PC Zillow property status report...");

    const allRecords = await fetchAnalyticsReport();
    const records = payload.maxRecords
      ? allRecords.slice(0, payload.maxRecords)
      : allRecords;

    console.log(`Processing ${records.length} of ${allRecords.length} records`);

    if (records.length === 0) {
      return { status: "completed", message: "No records to process" };
    }

    metadata.set("totalRecords", records.length);
    metadata.set("status", "processing");

    // For small runs (testing), use 1 batch to keep it simple
    const numBatches = payload.numBatches ?? (records.length > 2000 ? 4 : 1);

    let allResults: PropertyReportRow[];
    if (numBatches === 1) {
      // Single-batch path: run inline without spawning a sub-task
      let processedCount = 0;
      allResults = await withConcurrency(
        records.map((record, idx) => ({ ...record, rowIndex: idx + 1 })),
        20,
        async (record) => {
          const result = await checkPropertyInline(record);
          processedCount++;
          if (processedCount % 50 === 0 || processedCount === records.length) {
            const progress = Math.round((processedCount / records.length) * 100);
            metadata.set("processedCount", processedCount);
            metadata.set("progress", progress);
            console.log(`Progress: ${processedCount}/${records.length} (${progress}%)`);
          }
          return result;
        },
        500,
      );
    } else {
      allResults = await runReport(records);
    }

    const highConfidence = allResults.filter(r => r.confidence === "high");
    const reviewQueue = allResults.filter(r => r.confidence !== "high");
    const crmUpdated = highConfidence.filter(r => r.orderId && r.zillowUrl).length;

    let spreadsheetUrl: string | null = null;
    let spreadsheetError: string | null = null;
    try {
      spreadsheetUrl = await writePropertyReport(highConfidence, reviewQueue);
    } catch (err) {
      spreadsheetError = err instanceof Error ? err.message : "Unknown error";
      console.error(`Spreadsheet write failed (continuing to Slack): ${spreadsheetError}`);
    }

    metadata.set("status", "completed");
    metadata.set("crmUpdated", crmUpdated);
    metadata.set("spreadsheetUrl", spreadsheetUrl);

    await postRunSummary(records.length, allResults, spreadsheetUrl, spreadsheetError, payload.recordWeekly ?? false);

    return {
      status: "completed",
      totalRecords: records.length,
      highConfidence: highConfidence.length,
      reviewQueue: reviewQueue.length,
      crmUpdated,
      spreadsheetUrl,
    };
  },
});
