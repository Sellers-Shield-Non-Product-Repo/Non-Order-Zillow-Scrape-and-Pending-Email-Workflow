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
  // Env vars often store \n as literal two-char sequences — convert to real newlines
  const privateKey = rawKey.replace(/\\n/g, "\n");
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

// ----- Public API -----

/**
 * Write results to a Google Spreadsheet, creating new dated tabs each run:
 *   - "High Confidence M/D/YY"
 *   - "Review Queue M/D/YY"
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
