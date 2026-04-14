import { schedules, task, metadata } from "@trigger.dev/sdk/v3";
import { fetchAnalyticsReport } from "../lib/zoho-analytics.js";
import { searchZillowUrl, scrapeZillowProperty, preprocessSearchAddress } from "../lib/zillow.js";
import { updateRecord } from "../lib/zoho.js";
import {
  writePropertyReport,
  type PropertyReportRow,
} from "../lib/google-sheets.js";

// Concurrency-limited parallel execution helper
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// Inline property check — processes a single property and updates Zoho CRM
async function checkPropertyInline(payload: {
  orderId: string;
  displayName: string;
  city: string;
  state: string;
  currentStatus: string;
  statusUpdatedDate: string;
  zillowUrl: string;
  rowIndex: number;
}): Promise<PropertyReportRow> {
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
        };
      }
    }

    // Downgrade confidence for sold listings (often show different property)
    if (propertyData.status === "Sold" && confidence === "high" && !matchFlags.includes("CACHED_URL")) {
      console.log(`[${rowIndex}] Downgrading confidence: status is Sold`);
      confidence = "medium";
    }

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
    };
  }
}

// Main scheduled task — every Wednesday at 6 AM Central Time
// TODO: Adjust schedule as needed for the non-PC report
export const zillowNonPcReport = schedules.task({
  id: "zillow-non-pc-report",
  cron: { pattern: "0 6 * * 3", timezone: "America/Chicago" },
  run: async () => {
    console.log("Starting non-PC Zillow property status report...");

    // Step 1: Fetch report from Zoho Analytics
    const records = await fetchAnalyticsReport();
    console.log(`Fetched ${records.length} records from Zoho Analytics`);

    if (records.length === 0) {
      return {
        status: "completed",
        message: "No records in report",
        processed: 0,
      };
    }

    metadata.set("totalRecords", records.length);
    metadata.set("status", "processing");
    metadata.set("processedCount", 0);

    // Step 2: Process all properties concurrently (30 in-flight at a time)
    let processedCount = 0;
    const allResults = await withConcurrency(
      records.map((record, idx) => ({ ...record, rowIndex: idx + 1 })),
      30,
      async (record) => {
        const result = await checkPropertyInline(record);
        processedCount++;
        if (processedCount % 100 === 0 || processedCount === records.length) {
          const progress = Math.round((processedCount / records.length) * 100);
          metadata.set("processedCount", processedCount);
          metadata.set("progress", progress);
          console.log(`Progress: ${processedCount}/${records.length} (${progress}%)`);
        }
        return result;
      },
    );

    // Step 3: Split results by confidence
    const highConfidence = allResults.filter(
      (r) => r.confidence === "high"
    );
    const reviewQueue = allResults.filter((r) => r.confidence !== "high");

    // Count CRM updates (high confidence results that had an orderId)
    const crmUpdated = highConfidence.filter((r) => r.orderId && r.zillowUrl).length;

    console.log(
      `Results: ${highConfidence.length} high confidence, ${reviewQueue.length} for review, ${crmUpdated} CRM records updated`
    );

    // Step 4: Write to Google Spreadsheet
    const spreadsheetUrl = await writePropertyReport(
      highConfidence,
      reviewQueue
    );

    // Summary
    const summary = {
      status: "completed",
      totalRecords: records.length,
      highConfidence: highConfidence.length,
      reviewQueue: reviewQueue.length,
      crmUpdated,
      noMatch: allResults.filter((r) => !r.zillowUrl).length,
      withErrors: allResults.filter((r) => r.error).length,
      spreadsheetUrl,
    };

    metadata.set("status", "completed");
    metadata.set("crmUpdated", crmUpdated);
    metadata.set("spreadsheetUrl", spreadsheetUrl);

    console.log(
      `Report complete: ${summary.highConfidence} high, ${summary.reviewQueue} review, ${summary.crmUpdated} CRM updated`
    );
    console.log(`Spreadsheet: ${spreadsheetUrl}`);

    return summary;
  },
});

// Manual trigger for testing — processes a subset of the report
export const manualNonPcReport = task({
  id: "manual-non-pc-report",
  run: async (payload: { maxRecords?: number }) => {
    console.log("Starting manual non-PC Zillow property status report...");

    const allRecords = await fetchAnalyticsReport();
    const records = payload.maxRecords
      ? allRecords.slice(0, payload.maxRecords)
      : allRecords;

    console.log(
      `Processing ${records.length} of ${allRecords.length} records`
    );

    if (records.length === 0) {
      return { status: "completed", message: "No records to process" };
    }

    metadata.set("totalRecords", records.length);
    metadata.set("status", "processing");

    let processedCount = 0;
    const allResults = await withConcurrency(
      records.map((record, idx) => ({ ...record, rowIndex: idx + 1 })),
      30,
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
    );

    const highConfidence = allResults.filter(
      (r) => r.confidence === "high"
    );
    const reviewQueue = allResults.filter((r) => r.confidence !== "high");
    const crmUpdated = highConfidence.filter((r) => r.orderId && r.zillowUrl).length;

    const spreadsheetUrl = await writePropertyReport(
      highConfidence,
      reviewQueue
    );

    metadata.set("status", "completed");
    metadata.set("crmUpdated", crmUpdated);
    metadata.set("spreadsheetUrl", spreadsheetUrl);

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
