import { envvars } from "@trigger.dev/sdk/v3";

interface ZohoTokenResponse {
  access_token: string;
  expires_in: number;
  api_domain: string;
  token_type: string;
}

interface ZohoRecord {
  id: string;
  Display_Name?: string;
  Name?: string;
  Property_Address?: string;
  Property_City?: string;
  Property_State?: string;
  Property_Zipcode?: string;
  Zillow_URL?: string;
  List_Price?: number;
  Created_Time?: string;
  [key: string]: unknown;
}

interface BulkReadJobResponse {
  data: Array<{
    status: string;
    code: string;
    message: string;
    details: {
      id: string;
      operation: string;
      state: string;
      created_by: { id: string; name: string };
      created_time: string;
      result?: {
        page: number;
        count: number;
        download_url: string;
        more_records: boolean;
      };
    };
  }>;
}

let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();

  // Return cached token if still valid (with 5 min buffer)
  if (cachedAccessToken && tokenExpiry > now + 300000) {
    return cachedAccessToken;
  }

  const clientId = await envvars.retrieve("ZOHO_CLIENT_ID");
  const clientSecret = await envvars.retrieve("ZOHO_CLIENT_SECRET");
  // Try CRM-specific token first, fall back to Analytics token
  let refreshToken: { value: string };
  try {
    refreshToken = await envvars.retrieve("ZOHO_REFRESH_TOKEN");
  } catch {
    refreshToken = await envvars.retrieve("ZOHO_ANALYTICS_REFRESH_TOKEN");
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
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(
      `Failed to refresh Zoho token: ${response.status} - ${errorText}`
    );
  }

  const data: ZohoTokenResponse = await response.json();
  cachedAccessToken = data.access_token;
  tokenExpiry = now + data.expires_in * 1000;

  return cachedAccessToken;
}

/**
 * Create a bulk read job to fetch Orders created in the last hour
 */
export async function createBulkReadJob(): Promise<string> {
  const accessToken = await getAccessToken();
  const module = (await envvars.retrieve("ZOHO_MODULE")).value || "Orders";

  // Calculate timestamp for 1 hour ago in ISO8601 format (no milliseconds, with timezone offset)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  // Format: YYYY-MM-DDTHH:MM:SS+00:00 (Zoho doesn't support milliseconds)
  const isoTimestamp = oneHourAgo.toISOString().replace(/\.\d{3}Z$/, "+00:00");

  const requestBody = {
    query: {
      module: { api_name: module },
      // Don't specify fields - Zoho will return all available fields
      criteria: {
        field: { api_name: "Created_Time" },
        comparator: "greater_equal",
        value: isoTimestamp,
      },
    },
  };

  console.log(`Creating bulk read job for records created after: ${isoTimestamp}`);

  const response = await fetch("https://www.zohoapis.com/crm/bulk/v8/read", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create bulk read job: ${response.status} - ${errorText}`);
  }

  const data: BulkReadJobResponse = await response.json();

  if (data.data[0]?.status !== "success") {
    throw new Error(`Bulk read job creation failed: ${data.data[0]?.message}`);
  }

  const jobId = data.data[0].details.id;
  console.log(`Bulk read job created with ID: ${jobId}`);

  return jobId;
}

/**
 * Poll bulk read job status until completion
 */
export async function waitForBulkReadJob(
  jobId: string,
  maxWaitMs: number = 300000,
  pollIntervalMs: number = 5000
): Promise<{ downloadUrl: string; count: number }> {
  const accessToken = await getAccessToken();
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const response = await fetch(
      `https://www.zohoapis.com/crm/bulk/v8/read/${jobId}`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get job status: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log(`Bulk read job ${jobId} response:`, JSON.stringify(data, null, 2));

    const jobDetails = data.data?.[0]?.details || data.data?.[0];
    const state = jobDetails?.state || jobDetails?.status;

    console.log(`Bulk read job ${jobId} state: ${state}`);

    if (state === "COMPLETED") {
      const result = jobDetails?.result;
      if (!result?.download_url) {
        console.log("Full job details:", JSON.stringify(jobDetails, null, 2));
        throw new Error("Job completed but no download URL provided");
      }
      return {
        downloadUrl: result.download_url,
        count: result.count || 0,
      };
    }

    if (state === "FAILURE" || state === "FAILED") {
      throw new Error(`Bulk read job failed: ${jobDetails?.message || data.data?.[0]?.message || "Unknown error"}`);
    }

    // Also check for QUEUED and IN_PROGRESS states
    if (state !== "QUEUED" && state !== "IN_PROGRESS" && state !== "ADDED" && state !== undefined) {
      console.log(`Unexpected state: ${state}`);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Bulk read job timed out after ${maxWaitMs}ms`);
}

/**
 * Download and parse bulk read CSV results
 */
export async function downloadBulkReadResults(downloadUrl: string): Promise<ZohoRecord[]> {
  const accessToken = await getAccessToken();

  // Handle relative URLs by prepending the Zoho API domain
  const fullUrl = downloadUrl.startsWith("http")
    ? downloadUrl
    : `https://www.zohoapis.com${downloadUrl}`;

  console.log(`Downloading bulk read results from: ${fullUrl}`);

  const response = await fetch(fullUrl, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download bulk read results: ${response.status}`);
  }

  // Response is a ZIP file containing CSV
  const zipBuffer = await response.arrayBuffer();
  console.log(`Downloaded ${zipBuffer.byteLength} bytes`);

  const csvContent = await extractCsvFromZip(zipBuffer);
  console.log(`Extracted CSV content (first 500 chars): ${csvContent.substring(0, 500)}`);
  console.log(`CSV content length: ${csvContent.length}`);

  const records = parseCsvToRecords(csvContent);
  console.log(`Parsed ${records.length} records, first record:`, records[0]);

  return records;
}

/**
 * Extract CSV content from ZIP buffer
 * Handles DEFLATE compression used by ZIP files
 */
async function extractCsvFromZip(zipBuffer: ArrayBuffer): Promise<string> {
  const { inflateRawSync } = await import("zlib");
  const uint8 = new Uint8Array(zipBuffer);
  const decoder = new TextDecoder("utf-8");

  // Find the central directory file header (signature: 0x02014b50 = PK\x01\x02)
  // This has the correct compressed/uncompressed sizes
  let centralDirStart = -1;
  for (let i = uint8.length - 22; i >= 0; i--) {
    if (uint8[i] === 0x50 && uint8[i + 1] === 0x4b && uint8[i + 2] === 0x01 && uint8[i + 3] === 0x02) {
      centralDirStart = i;
      break;
    }
  }

  if (centralDirStart === -1) {
    throw new Error("Invalid ZIP file: no central directory found");
  }

  // Parse central directory header for sizes
  const compressionMethod = uint8[centralDirStart + 10] | (uint8[centralDirStart + 11] << 8);
  const compressedSize = uint8[centralDirStart + 20] | (uint8[centralDirStart + 21] << 8) |
                         (uint8[centralDirStart + 22] << 16) | (uint8[centralDirStart + 23] << 24);
  const uncompressedSize = uint8[centralDirStart + 24] | (uint8[centralDirStart + 25] << 8) |
                           (uint8[centralDirStart + 26] << 16) | (uint8[centralDirStart + 27] << 24);

  console.log(`ZIP: compression=${compressionMethod}, compressed=${compressedSize}, uncompressed=${uncompressedSize}`);

  // Find the local file header to get data start position
  let headerStart = -1;
  for (let i = 0; i < uint8.length - 4; i++) {
    if (uint8[i] === 0x50 && uint8[i + 1] === 0x4b && uint8[i + 2] === 0x03 && uint8[i + 3] === 0x04) {
      headerStart = i;
      break;
    }
  }

  if (headerStart === -1) {
    throw new Error("Invalid ZIP file: no local file header found");
  }

  const filenameLen = uint8[headerStart + 26] | (uint8[headerStart + 27] << 8);
  const extraLen = uint8[headerStart + 28] | (uint8[headerStart + 29] << 8);
  const dataStart = headerStart + 30 + filenameLen + extraLen;
  const compressedData = uint8.slice(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) {
    // No compression (stored)
    return decoder.decode(compressedData);
  } else if (compressionMethod === 8) {
    // DEFLATE compression
    const decompressed = inflateRawSync(Buffer.from(compressedData));
    return decoder.decode(decompressed);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }
}

/**
 * Parse CSV string to ZohoRecord array
 */
function parseCsvToRecords(csvContent: string): ZohoRecord[] {
  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) {
    return [];
  }

  // Parse header row
  const headers = parseCsvLine(lines[0]);
  const records: ZohoRecord[] = [];

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const record: ZohoRecord = { id: "" };

    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      const value = values[j] || "";

      // Map CSV headers to record fields
      if (header === "id" || header === "Id" || header === "ID") {
        record.id = value;
      } else {
        record[header] = value || undefined;
      }
    }

    if (record.id) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * Fetch all Orders created in the last hour using Bulk Read API
 */
export async function fetchRecentOrders(): Promise<ZohoRecord[]> {
  // Step 1: Create bulk read job
  const jobId = await createBulkReadJob();

  // Step 2: Wait for job completion
  const { downloadUrl, count } = await waitForBulkReadJob(jobId);

  if (count === 0) {
    console.log("No records found in the last hour");
    return [];
  }

  console.log(`Bulk read job completed with ${count} records`);

  // Step 3: Download and parse results
  const records = await downloadBulkReadResults(downloadUrl);

  console.log(`Parsed ${records.length} records from CSV`);
  return records;
}

/**
 * Fetch one or more field values from a Zoho CRM record.
 * Returns a map keyed by field name; values are strings for populated fields
 * and null when empty/unset/missing.
 */
export async function getRecordFields(
  recordId: string,
  fields: string[]
): Promise<Record<string, string | null>> {
  const accessToken = await getAccessToken();
  const module = (await envvars.retrieve("ZOHO_MODULE")).value || "Orders";

  const fieldsParam = fields.join(",");

  const response = await fetch(
    `https://www.zohoapis.com/crm/v2/${module}/${recordId}?fields=${encodeURIComponent(fieldsParam)}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    }
  );

  if (response.status === 204 || response.status === 404) {
    return Object.fromEntries(fields.map((f) => [f, null]));
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch fields [${fieldsParam}] for record ${recordId}: ${response.status} - ${errorText}`
    );
  }

  const data = await response.json();
  const result: Record<string, string | null> = {};
  for (const field of fields) {
    const value = data?.data?.[0]?.[field];
    result[field] =
      value === null || value === undefined || value === ""
        ? null
        : String(value);
  }
  return result;
}

/**
 * Convenience wrapper around getRecordFields for fetching a single field.
 */
export async function getRecordField(
  recordId: string,
  field: string
): Promise<string | null> {
  const fields = await getRecordFields(recordId, [field]);
  return fields[field];
}

/**
 * List all fields (with their API names and display names) for the configured
 * Zoho CRM module. Useful for discovering exact field API names without
 * guessing capitalization.
 */
export async function listModuleFields(): Promise<
  Array<{ api_name: string; field_label: string; data_type: string }>
> {
  const accessToken = await getAccessToken();
  const module = (await envvars.retrieve("ZOHO_MODULE")).value || "Orders";

  const response = await fetch(
    `https://www.zohoapis.com/crm/v2/settings/fields?module=${encodeURIComponent(module)}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to list module fields: ${response.status} - ${errorText}`
    );
  }

  const data = await response.json();
  return (data?.fields || []) as Array<{
    api_name: string;
    field_label: string;
    data_type: string;
  }>;
}

/**
 * Find a record ID by email using Zoho's search API.
 */
export async function searchRecordIdByEmail(email: string): Promise<string | null> {
  const accessToken = await getAccessToken();
  const module = (await envvars.retrieve("ZOHO_MODULE")).value || "Orders";

  const criteria = `(Email:equals:${email})`;
  const url = `https://www.zohoapis.com/crm/v2/${module}/search?criteria=${encodeURIComponent(criteria)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to search by email ${email}: ${response.status} - ${errorText}`
    );
  }

  const data = await response.json();
  return (data?.data?.[0]?.id as string) || null;
}

/**
 * Fetch a full Zoho CRM record (all fields) by ID. Useful for discovering
 * actual field API names when the metadata endpoint isn't sufficient.
 */
export async function getFullRecord(
  recordId: string
): Promise<Record<string, unknown> | null> {
  const accessToken = await getAccessToken();
  const module = (await envvars.retrieve("ZOHO_MODULE")).value || "Orders";

  const response = await fetch(
    `https://www.zohoapis.com/crm/v2/${module}/${recordId}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    }
  );

  if (response.status === 204 || response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch full record ${recordId}: ${response.status} - ${errorText}`
    );
  }

  const data = await response.json();
  return (data?.data?.[0] || null) as Record<string, unknown> | null;
}

export async function updateRecord(
  recordId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  const accessToken = await getAccessToken();
  const module = (await envvars.retrieve("ZOHO_MODULE")).value || "Orders";

  const response = await fetch(
    `https://www.zohoapis.com/crm/v2/${module}/${recordId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: [data] }),
    }
  );

  const responseBody = await response.text();

  if (!response.ok) {
    console.error(`Failed to update record ${recordId}: ${responseBody}`);
    return false;
  }

  // Log the actual Zoho response to catch silent field rejections
  console.log(`Zoho CRM update response for ${recordId}: ${responseBody}`);
  return true;
}

export const STATE_NAME_TO_ABBR: Record<string, string> = {
  "alabama": "AL",
  "alaska": "AK",
  "arizona": "AZ",
  "arkansas": "AR",
  "california": "CA",
  "colorado": "CO",
  "connecticut": "CT",
  "delaware": "DE",
  "florida": "FL",
  "georgia": "GA",
  "hawaii": "HI",
  "idaho": "ID",
  "illinois": "IL",
  "indiana": "IN",
  "iowa": "IA",
  "kansas": "KS",
  "kentucky": "KY",
  "louisiana": "LA",
  "maine": "ME",
  "maryland": "MD",
  "massachusetts": "MA",
  "michigan": "MI",
  "minnesota": "MN",
  "mississippi": "MS",
  "missouri": "MO",
  "montana": "MT",
  "nebraska": "NE",
  "nevada": "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  "ohio": "OH",
  "oklahoma": "OK",
  "oregon": "OR",
  "pennsylvania": "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  "tennessee": "TN",
  "texas": "TX",
  "utah": "UT",
  "vermont": "VT",
  "virginia": "VA",
  "washington": "WA",
  "west virginia": "WV",
  "wisconsin": "WI",
  "wyoming": "WY",
  "district of columbia": "DC",
};

const STATE_ABBR_SET = new Set(Object.values(STATE_NAME_TO_ABBR));
const STATE_NAME_LIST = Object.keys(STATE_NAME_TO_ABBR).sort((a, b) => b.length - a.length);

function normalizeWhitespace(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeState(value: string): string {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) return "";
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && STATE_ABBR_SET.has(upper)) {
    return upper;
  }
  const name = trimmed.toLowerCase();
  return STATE_NAME_TO_ABBR[name] || trimmed;
}

function insertMissingSeparators(value: string): string {
  let normalized = normalizeWhitespace(value);
  if (!normalized) return normalized;
  normalized = normalized.replace(/([A-Za-z])(\d{5})(?!\d)/g, "$1 $2");
  normalized = normalized.replace(/(\d{5})([A-Za-z])/g, "$1 $2");
  return normalized;
}

function normalizeStreet(value: string): string {
  let normalized = normalizeWhitespace(value);
  if (!normalized) return normalized;

  const replacements: Array<[RegExp, string]> = [
    [/\bNorthwest\b/gi, "NW"],
    [/\bNortheast\b/gi, "NE"],
    [/\bSouthwest\b/gi, "SW"],
    [/\bSoutheast\b/gi, "SE"],
    [/\bNorth\b/gi, "N"],
    [/\bSouth\b/gi, "S"],
    [/\bEast\b/gi, "E"],
    [/\bWest\b/gi, "W"],
    [/\bStreet\b/gi, "St"],
    [/\bAvenue\b/gi, "Ave"],
    [/\bRoad\b/gi, "Rd"],
    [/\bDrive\b/gi, "Dr"],
    [/\bBoulevard\b/gi, "Blvd"],
    [/\bLane\b/gi, "Ln"],
    [/\bCourt\b/gi, "Ct"],
    [/\bPlace\b/gi, "Pl"],
    [/\bTerrace\b/gi, "Ter"],
    [/\bCircle\b/gi, "Cir"],
    [/\bHighway\b/gi, "Hwy"],
  ];

  for (const [pattern, replacement] of replacements) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized.replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
  return normalized;
}

function extractStateFromTail(tail: string): { state: string; remainingTail: string } {
  let cleaned = normalizeWhitespace(tail).replace(/,+/g, " ").trim();
  if (!cleaned) {
    return { state: "", remainingTail: "" };
  }

  for (const name of STATE_NAME_LIST) {
    const pattern = new RegExp(`\\b${name}\\b$`, "i");
    if (pattern.test(cleaned)) {
      const remainingTail = cleaned.replace(pattern, "").trim();
      return { state: STATE_NAME_TO_ABBR[name], remainingTail };
    }
  }

  const abbrMatch = cleaned.match(/\b([A-Za-z]{2})$/);
  if (abbrMatch) {
    const abbr = abbrMatch[1].toUpperCase();
    if (STATE_ABBR_SET.has(abbr)) {
      const remainingTail = cleaned.slice(0, abbrMatch.index).trim();
      return { state: abbr, remainingTail };
    }
  }

  return { state: "", remainingTail: cleaned };
}

function normalizeAddressParts(
  rawAddress: string,
  rawCity: string,
  rawState: string,
  rawZip: string
): { street: string; city: string; state: string; zip: string } {
  let street = insertMissingSeparators(rawAddress);
  let city = normalizeWhitespace(rawCity);
  let state = normalizeWhitespace(rawState);
  let zip = normalizeWhitespace(rawZip);

  const zipMatch = street.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (!zip && zipMatch) {
    zip = zipMatch[1];
  }

  if (zipMatch) {
    const zipIndex = street.indexOf(zipMatch[0]);
    const beforeZip = street.slice(0, zipIndex).trim();
    const afterZip = street.slice(zipIndex + zipMatch[0].length).trim();
    if (beforeZip) {
      street = beforeZip;
    }

    if ((!city || !state) && afterZip) {
      const extracted = extractStateFromTail(afterZip);
      if (!state && extracted.state) {
        state = extracted.state;
      }
      if (!city && extracted.remainingTail) {
        city = extracted.remainingTail;
      }
    }
  }

  if (!city || !state) {
    const commaParts = street.split(",").map((part) => part.trim()).filter(Boolean);
    if (commaParts.length >= 2) {
      const tail = commaParts.pop() || "";
      const extracted = extractStateFromTail(tail);
      if (!state && extracted.state) {
        state = extracted.state;
      }
      if (!city && extracted.remainingTail) {
        city = extracted.remainingTail;
      } else if (!city && tail) {
        city = tail;
      }
      street = commaParts.join(", ");
    }
  }

  street = normalizeStreet(street);
  city = normalizeWhitespace(city);
  state = normalizeState(state);
  zip = normalizeWhitespace(zip);

  return { street, city, state, zip };
}

export function buildAddress(record: ZohoRecord): string {
  // Log available fields to help debug field name mismatches
  const fieldNames = Object.keys(record).filter(k => record[k] !== null && record[k] !== undefined && record[k] !== "");
  console.log(`Record ${record.id} fields: ${fieldNames.join(", ")}`);

  // Try different field combinations for address
  const address =
    record.Property_Address ||
    record.Street_Address ||
    record.Address ||
    record.Display_Name ||
    record.Name ||
    "";
  // Try different field combinations for city
  const city = record.Property_City || record.City || "";
  // Try different field combinations for state
  const state = record.Property_State || record.State || "";
  // Try different field combinations for zipcode
  const zipcode = record.Property_Zipcode || record.Zipcode || record.Zip || record.Zip_Code || "";

  const normalized = normalizeAddressParts(
    String(address || ""),
    String(city || ""),
    String(state || ""),
    String(zipcode || "")
  );

  const parts: string[] = [];
  if (normalized.street) parts.push(normalized.street);
  if (normalized.city) parts.push(normalized.city);
  if (normalized.state) parts.push(normalized.state);
  if (normalized.zip) parts.push(normalized.zip);

  const fullAddress = parts.join(", ");
  console.log(`Built address: "${fullAddress}"`);

  return fullAddress;
}

export type { ZohoRecord };
