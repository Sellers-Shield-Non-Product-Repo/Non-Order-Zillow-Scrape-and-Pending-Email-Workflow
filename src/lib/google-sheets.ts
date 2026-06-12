import { createSign } from "crypto";
import { envvars } from "@trigger.dev/sdk/v3";

export interface PropertyReportRow {
  orderId: string;
  displayName: string;
  city: string;
  state: string;
  currentStatus: string;
  statusUpdatedDate: string;
  zillowUrl: string | null;
  zillowStatus: string | null;
  listPrice: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  confidence: "high" | "medium" | "low" | null;
  matchScore: number;
  matchFlags: string[];
  error: string | null;
  pendingEmailScheduled: boolean;
  pendingEmailScheduledFor: string | null;
}

// ----- Google Auth (zero-dependency JWT) -----

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getGoogleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && tokenExpiry > now + 60) {
    return cachedToken;
  }

  // Use individual env vars (email + private key) — same pattern as other automations
  const email = (await envvars.retrieve("GOOGLE_SERVICE_ACCOUNT_EMAIL")).value;
  const rawKey = (await envvars.retrieve("GOOGLE_PRIVATE_KEY")).value;
  // Normalize PEM key: handle literal \n, missing newlines, surrounding quotes
  let privateKey = rawKey.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
  // If the key is a single line (no real newlines between header and content), reconstruct PEM
  if (!privateKey.includes("\n") || privateKey.match(/-----BEGIN[^-]+-----[^\n]/)) {
    const b64 = privateKey
      .replace(/-----BEGIN [A-Z ]+-----/, "")
      .replace(/-----END [A-Z ]+-----/, "")
      .replace(/\s/g, "");
    const lines = b64.match(/.{1,64}/g) || [];
    privateKey = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  }
  const credentials: ServiceAccountCredentials = {
    client_email: email,
    private_key: privateKey,
  };

  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");

  const claims = Buffer.from(
    JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url");

  const signInput = `${header}.${claims}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(credentials.private_key, "base64url");

  const jwt = `${signInput}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google OAuth failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in || 3600);

  return cachedToken!;
}

// ----- Google Sheets REST API helper -----

async function sheetsApi(
  path: string,
  method: string,
  body?: unknown
): Promise<unknown> {
  const token = await getGoogleAccessToken();
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Sheets API ${method} ${path} failed (${response.status}): ${errorText}`
    );
  }

  return response.json();
}

// Tabs older than the most-recent N runs are deleted at the start of each run
// to keep the workbook under Google's 10,000,000-cell hard limit. Each run
// writes ~750k cells across its two tabs, so keeping ~5 runs (10 tabs) leaves
// generous headroom. Override via SHEET_MAX_REPORT_TABS.
const DEFAULT_MAX_REPORT_TABS = 10;

const REPORT_TAB_REGEX = /^(High Confidence|Review Queue)\s+(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})([ap])/;

/**
 * Parse a sortable timestamp from a report tab title like
 * "High Confidence 5/18/26 8:07p". Returns null if the title isn't a report tab.
 */
function parseReportTabTimestamp(title: string): number | null {
  const m = title.match(REPORT_TAB_REGEX);
  if (!m) return null;
  const [, , mm, dd, yy, hh, min, ap] = m;
  let hour = Number(hh) % 12;
  if (ap === "p") hour += 12;
  // 2-digit year → 2000s
  return new Date(
    2000 + Number(yy),
    Number(mm) - 1,
    Number(dd),
    hour,
    Number(min)
  ).getTime();
}

/**
 * Delete old "High Confidence" / "Review Queue" tabs, keeping only the most
 * recent `keep` of them. Best-effort: logs and continues on any error so a
 * prune failure never blocks the actual report write. Non-report tabs (e.g.
 * a manually-created sheet) are never touched.
 */
export async function pruneOldReportTabs(
  spreadsheetId: string,
  keep: number
): Promise<void> {
  try {
    const meta = (await sheetsApi(
      `/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
      "GET"
    )) as { sheets?: Array<{ properties: { sheetId: number; title: string } }> };

    const reportTabs = (meta.sheets || [])
      .map((s) => ({
        sheetId: s.properties.sheetId,
        title: s.properties.title,
        ts: parseReportTabTimestamp(s.properties.title),
      }))
      .filter((s): s is { sheetId: number; title: string; ts: number } => s.ts !== null)
      .sort((a, b) => b.ts - a.ts); // newest first

    const toDelete = reportTabs.slice(keep);
    if (toDelete.length === 0) {
      console.log(`Tab prune: ${reportTabs.length} report tabs, none to delete (keeping ${keep})`);
      return;
    }

    console.log(
      `Tab prune: ${reportTabs.length} report tabs found, deleting ${toDelete.length} oldest (keeping ${keep})`
    );

    await sheetsApi(`/${spreadsheetId}:batchUpdate`, "POST", {
      requests: toDelete.map((s) => ({ deleteSheet: { sheetId: s.sheetId } })),
    });
    console.log(`Tab prune: deleted ${toDelete.map((s) => s.title).join(", ")}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Tab prune failed (continuing anyway): ${msg}`);
  }
}

// Persistent tab that accumulates one row per weekly run for week-over-week
// tracking. Never pruned (doesn't match REPORT_TAB_REGEX).
const WEEKLY_SUMMARY_TAB = "Weekly Summary";

const WEEKLY_SUMMARY_HEADERS = [
  "Run Date",
  "Total Checked",
  "High Confidence",
  "High %",
  "Review Queue",
  "New Status Updates",
  "Status Breakdown",
  "New Pendings",
  "Spreadsheet Status",
];

export interface WeeklySummaryRow {
  runDate: string;
  totalChecked: number;
  highConfidence: number;
  highPct: number;
  reviewQueue: number;
  totalStatusUpdates: number;
  statusBreakdown: Map<string, number>;
  newPendings: number;
  spreadsheetError?: string | null;
}

/**
 * Append a single row to the persistent "Weekly Summary" tab, creating the tab
 * (with headers) on first use. Best-effort: logs and continues on error.
 */
export async function appendWeeklySummary(row: WeeklySummaryRow): Promise<void> {
  try {
    const spreadsheetId = (await envvars.retrieve("GOOGLE_SPREADSHEET_ID")).value;

    // Ensure the tab exists; create it with a header row if missing.
    const meta = (await sheetsApi(
      `/${spreadsheetId}?fields=sheets.properties(title)`,
      "GET"
    )) as { sheets?: Array<{ properties: { title: string } }> };

    const exists = (meta.sheets || []).some(
      (s) => s.properties.title === WEEKLY_SUMMARY_TAB
    );

    if (!exists) {
      await sheetsApi(`/${spreadsheetId}:batchUpdate`, "POST", {
        requests: [{ addSheet: { properties: { title: WEEKLY_SUMMARY_TAB } } }],
      });
      await sheetsApi(
        `/${spreadsheetId}/values/${encodeURIComponent(`'${WEEKLY_SUMMARY_TAB}'!A1`)}?valueInputOption=RAW`,
        "PUT",
        { values: [WEEKLY_SUMMARY_HEADERS] }
      );
      console.log(`Created "${WEEKLY_SUMMARY_TAB}" tab with headers`);
    }

    const breakdownText = [...row.statusBreakdown.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${status}: ${count}`)
      .join("; ");

    const values = [
      [
        row.runDate,
        row.totalChecked,
        row.highConfidence,
        `${row.highPct}%`,
        row.reviewQueue,
        row.totalStatusUpdates,
        breakdownText,
        row.newPendings,
        row.spreadsheetError ? `FAILED: ${row.spreadsheetError}` : "OK",
      ],
    ];

    await sheetsApi(
      `/${spreadsheetId}/values/${encodeURIComponent(`'${WEEKLY_SUMMARY_TAB}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      "POST",
      { values }
    );
    console.log(`Appended weekly summary row for ${row.runDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Weekly summary append failed (continuing anyway): ${msg}`);
  }
}

// ----- Public API -----

/**
 * Write results to a Google Spreadsheet, creating new dated tabs each run:
 *   - "High Confidence M/D/YY"
 *   - "Review Queue M/D/YY"
 *
 * Old report tabs are pruned first (keeping the most recent N) so the workbook
 * stays under Google's 10M-cell limit.
 *
 * Returns the spreadsheet URL.
 */
export async function writePropertyReport(
  highConfidence: PropertyReportRow[],
  reviewQueue: PropertyReportRow[]
): Promise<string> {
  const spreadsheetId = (
    await envvars.retrieve("GOOGLE_SPREADSHEET_ID")
  ).value;

  // Prune old tabs BEFORE creating new ones, so we free cells first (this also
  // self-heals a workbook that's already at the cell limit).
  let maxTabs = DEFAULT_MAX_REPORT_TABS;
  try {
    const override = (await envvars.retrieve("SHEET_MAX_REPORT_TABS")).value;
    const parsed = parseInt(override, 10);
    if (!Number.isNaN(parsed) && parsed > 0) maxTabs = parsed;
  } catch {
    // env var not set — use default
  }
  await pruneOldReportTabs(spreadsheetId, maxTabs);

  // Format date as M/D/YY H:MMa (e.g. "3/25/26 2:45p") to allow multiple runs per day
  const now = new Date();
  const dateSuffix = `${now.getMonth() + 1}/${now.getDate()}/${String(now.getFullYear()).slice(2)}`;
  const hours = now.getUTCHours();
  const h12 = hours % 12 || 12;
  const ampm = hours < 12 ? "a" : "p";
  const timeSuffix = `${h12}:${String(now.getUTCMinutes()).padStart(2, "0")}${ampm}`;
  const highTabName = `High Confidence ${dateSuffix} ${timeSuffix}`;
  const reviewTabName = `Review Queue ${dateSuffix} ${timeSuffix}`;

  console.log(
    `Writing report to spreadsheet ${spreadsheetId}: tabs "${highTabName}" (${highConfidence.length} rows), "${reviewTabName}" (${reviewQueue.length} rows)`
  );

  // 1. Create new tabs — use random-ish IDs to avoid collisions
  const highSheetId = Math.floor(Math.random() * 1_000_000_000);
  const reviewSheetId = Math.floor(Math.random() * 1_000_000_000);

  await sheetsApi(`/${spreadsheetId}:batchUpdate`, "POST", {
    requests: [
      {
        addSheet: {
          properties: { sheetId: highSheetId, title: highTabName, index: 0 },
        },
      },
      {
        addSheet: {
          properties: { sheetId: reviewSheetId, title: reviewTabName, index: 1 },
        },
      },
    ],
  });

  // 2. Write data to the new tabs
  const highHeaders = [
    "Order ID",
    "Display Name",
    "City",
    "State",
    "Current Status",
    "Status Updated",
    "Zillow URL",
    "Zillow Status",
    "List Price",
    "Beds",
    "Baths",
    "SqFt",
    "Confidence",
    "Match Score",
  ];

  const highRows = highConfidence.map((r) => [
    r.orderId,
    r.displayName,
    r.city,
    r.state,
    r.currentStatus,
    r.statusUpdatedDate,
    r.zillowUrl || "",
    r.zillowStatus || "",
    r.listPrice ?? "",
    r.bedrooms ?? "",
    r.bathrooms ?? "",
    r.squareFeet ?? "",
    r.confidence || "",
    r.matchScore || "",
  ]);

  const reviewHeaders = [...highHeaders, "Match Flags", "Error"];

  const reviewRows = reviewQueue.map((r) => [
    r.orderId,
    r.displayName,
    r.city,
    r.state,
    r.currentStatus,
    r.statusUpdatedDate,
    r.zillowUrl || "",
    r.zillowStatus || "",
    r.listPrice ?? "",
    r.bedrooms ?? "",
    r.bathrooms ?? "",
    r.squareFeet ?? "",
    r.confidence || "",
    r.matchScore || "",
    (r.matchFlags || []).join("; "),
    r.error || "",
  ]);

  await sheetsApi(`/${spreadsheetId}/values:batchUpdate`, "POST", {
    valueInputOption: "RAW",
    data: [
      {
        range: `'${highTabName}'!A1`,
        values: [highHeaders, ...highRows],
      },
      {
        range: `'${reviewTabName}'!A1`,
        values: [reviewHeaders, ...reviewRows],
      },
    ],
  });

  // 3. Bold + grey header rows on both new tabs
  await sheetsApi(`/${spreadsheetId}:batchUpdate`, "POST", {
    requests: [highSheetId, reviewSheetId].map((sheetId) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    })),
  });

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  console.log(`Report written: ${url}`);
  return url;
}
