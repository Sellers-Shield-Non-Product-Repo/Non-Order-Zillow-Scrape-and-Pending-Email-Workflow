import { envvars } from "@trigger.dev/sdk/v3";

export interface ReportRecord {
  orderId: string;
  displayName: string;
  city: string;
  state: string;
  currentStatus: string;
  statusUpdatedDate: string;
  closingDate: string;
  closingDateIsWrong: string;
  createdTime: string;
  hslpOrderedAt: string;
  zillowUrl: string;
}

// ----- Zoho Analytics OAuth (separate from CRM token) -----

interface ZohoTokenResponse {
  access_token: string;
  expires_in: number;
  api_domain: string;
  token_type: string;
}

let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Get an access token with ZohoAnalytics.data.read scope.
 * Uses ZOHO_ANALYTICS_REFRESH_TOKEN (falls back to ZOHO_REFRESH_TOKEN).
 */
async function getAnalyticsAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedAccessToken && tokenExpiry > now + 300000) {
    return cachedAccessToken;
  }

  // Try Analytics-specific env vars first, fall back to shared ones
  const clientId = await envvars.retrieve("ZOHO_CLIENT_ID");
  const clientSecret = await envvars.retrieve("ZOHO_CLIENT_SECRET");

  let refreshToken: { value: string };
  try {
    refreshToken = await envvars.retrieve("ZOHO_ANALYTICS_REFRESH_TOKEN");
  } catch {
    refreshToken = await envvars.retrieve("ZOHO_REFRESH_TOKEN");
  }

  const response = await fetch(
    `https://accounts.zoho.com/oauth/v2/token?` +
      `refresh_token=${refreshToken.value}&` +
      `client_id=${clientId.value}&` +
      `client_secret=${clientSecret.value}&` +
      `grant_type=refresh_token`,
    { method: "POST" }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to refresh Zoho Analytics token: ${response.status} - ${errorText}`
    );
  }

  const data: ZohoTokenResponse = await response.json();
  cachedAccessToken = data.access_token;
  tokenExpiry = now + data.expires_in * 1000;

  return cachedAccessToken;
}

// ----- Report Export -----

/**
 * Export the non-PC report from Zoho Analytics.
 * Report IDs are configured via env vars:
 *   ZOHO_ANALYTICS_WORKSPACE_ID, ZOHO_ANALYTICS_VIEW_ID
 */
export async function fetchAnalyticsReport(): Promise<ReportRecord[]> {
  const accessToken = await getAnalyticsAccessToken();
  const orgId = await envvars.retrieve("ZOHO_ORG_ID");
  const workspaceId = (await envvars.retrieve("ZOHO_ANALYTICS_WORKSPACE_ID")).value;
  const viewId = (await envvars.retrieve("ZOHO_ANALYTICS_VIEW_ID")).value;

  const config = JSON.stringify({ responseFormat: "csv" });
  const url = `https://analyticsapi.zoho.com/restapi/v2/workspaces/${workspaceId}/views/${viewId}/data?CONFIG=${encodeURIComponent(config)}`;

  console.log(
    `Fetching Analytics report (workspace ${workspaceId}, view ${viewId})`
  );

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "ZANALYTICS-ORGID": orgId.value,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Zoho Analytics export failed (${response.status}): ${errorText}`
    );
  }

  const csvContent = await response.text();
  console.log(`Received ${csvContent.length} bytes of CSV data`);

  const records = parseReportCsv(csvContent);
  console.log(`Parsed ${records.length} valid records (skipped N/A addresses)`);

  return records;
}

/**
 * Parse the report CSV into structured records.
 * Uses dynamic header detection so the view can add/reorder columns freely.
 * Required columns: "Id", "Display name", "Property city", "Property state"
 * Optional column: "Zillow_URL" — when present, SERP search is skipped
 */
function parseReportCsv(csv: string): ReportRecord[] {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return [];

  // Build header index from first row
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name: string): number => headers.indexOf(name.toLowerCase());

  // Map known column names (case-insensitive)
  const idIdx = col("id");
  const displayIdx = col("display name");
  const cityIdx = col("property city");
  const stateIdx = col("property state");
  const statusIdx = col("property status");
  const statusDateIdx = col("date of property status updated");
  const closingIdx = col("date of closing date");
  const closingWrongIdx = col("closing date is wrong");
  const createdIdx = col("date of created time");
  const hslpIdx = col("date of hslp ordered at");
  const zillowUrlIdx = col("zillow_url");

  if (idIdx === -1 || displayIdx === -1) {
    console.error(`CSV header missing required columns. Found: ${headers.join(", ")}`);
    return [];
  }

  if (zillowUrlIdx !== -1) {
    console.log("Zillow_URL column detected — will skip SERP search for records with existing URLs");
  }

  const records: ReportRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const values = parseCsvLine(lines[i]);
    const orderId = values[idIdx]?.trim();
    const displayName = values[displayIdx]?.trim();
    const city = values[cityIdx]?.trim();
    const state = values[stateIdx]?.trim();

    // Skip rows with no usable address
    if (
      !orderId ||
      !displayName ||
      displayName === "N/A N/A" ||
      displayName === "N/A"
    )
      continue;

    records.push({
      orderId,
      displayName,
      city: cleanZohoValue(city),
      state: cleanZohoValue(state),
      currentStatus: statusIdx !== -1 ? cleanZohoValue(values[statusIdx]) : "",
      statusUpdatedDate: statusDateIdx !== -1 ? cleanZohoValue(values[statusDateIdx]) : "",
      closingDate: closingIdx !== -1 ? cleanZohoValue(values[closingIdx]) : "",
      closingDateIsWrong: closingWrongIdx !== -1 ? (values[closingWrongIdx]?.trim() || "") : "",
      createdTime: createdIdx !== -1 ? (values[createdIdx]?.trim() || "") : "",
      hslpOrderedAt: hslpIdx !== -1 ? (values[hslpIdx]?.trim() || "") : "",
      zillowUrl: zillowUrlIdx !== -1 ? cleanZohoValue(values[zillowUrlIdx]) : "",
    });
  }

  return records;
}

function cleanZohoValue(value: string | undefined): string {
  const trimmed = (value || "").trim();
  return trimmed === "-No Value-" || trimmed === "N/A" ? "" : trimmed;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }

  result.push(current);
  return result;
}
