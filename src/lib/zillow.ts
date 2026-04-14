import { envvars } from "@trigger.dev/sdk/v3";
import { STATE_NAME_TO_ABBR } from "./zoho.js";

const STATE_ABBR_TO_NAME = new Map(
  Object.entries(STATE_NAME_TO_ABBR).map(([name, abbr]) => [abbr, name])
);
const STATE_ABBR_SET = new Set(Object.values(STATE_NAME_TO_ABBR));

// 2-letter directionals to keep uppercase after title-casing
const UPPER_DIRECTIONALS = new Set(["NW", "NE", "SW", "SE", "N", "S", "E", "W"]);

/**
 * Preprocess raw address inputs before Zillow search.
 * Strips zips, normalizes case, removes periods, deduplicates embedded city/state.
 */
export function preprocessSearchAddress(
  displayName: string,
  city: string,
  state: string
): { searchAddress: string; validationAddress: string } {
  let cleaned = (displayName || "").trim();

  // Strip trailing zip(s) — handles duplicate zips ("95993 95993") and zip+4
  let extractedZip = "";
  const zipMatch = cleaned.match(/[\s,]+(\d{5})(?:-\d{4})?(?:\s+\d{5}(?:-\d{4})?)*\s*$/);
  if (zipMatch) {
    extractedZip = zipMatch[1]; // first 5-digit zip
    cleaned = cleaned.slice(0, zipMatch.index).trim();
  }

  // Normalize ALL CAPS to title case, preserving directionals
  if (cleaned === cleaned.toUpperCase() && /[A-Z]{2,}/.test(cleaned)) {
    cleaned = cleaned
      .split(/\s+/)
      .map((word) => {
        const upper = word.toUpperCase().replace(/[.,]/g, "");
        if (UPPER_DIRECTIONALS.has(upper)) return upper;
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");
  }

  // Strip periods from abbreviations (Blvd. → Blvd, W. → W)
  cleaned = cleaned.replace(/\.(?=\s|$|,)/g, "");

  // Remove # symbols
  cleaned = cleaned.replace(/#/g, "");

  // Collapse whitespace and normalize commas
  cleaned = cleaned.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();

  // Normalize city and state inputs
  const normCity = (city || "").trim();
  const normState = (state || "").trim();

  // Convert state to abbreviation
  let stateAbbr = "";
  if (normState) {
    const lower = normState.toLowerCase();
    if (normState.length === 2 && STATE_ABBR_SET.has(normState.toUpperCase())) {
      stateAbbr = normState.toUpperCase();
    } else if (STATE_NAME_TO_ABBR[lower]) {
      stateAbbr = STATE_NAME_TO_ABBR[lower];
    } else {
      stateAbbr = normState;
    }
  }

  // Detect if city/state is already embedded in the tail of displayName
  // e.g. "275 Saegert Rd Paige, TX" with city=PAIGE, state=Texas
  const cleanedLower = cleaned.toLowerCase();
  const cityLower = normCity.toLowerCase();
  let appendCity = true;
  let appendState = true;

  if (cityLower && cleanedLower.includes(cityLower)) {
    appendCity = false;
  }
  if (stateAbbr) {
    // Check for state abbreviation or full name in the tail
    const statePattern = new RegExp(
      `\\b(${stateAbbr}|${STATE_ABBR_TO_NAME.get(stateAbbr) || ""})\\b`,
      "i"
    );
    if (statePattern.test(cleaned)) {
      appendState = false;
    }
  }

  // Build search address (no zip)
  let searchAddress = cleaned;
  if (appendCity && normCity) {
    searchAddress += `, ${normCity.charAt(0).toUpperCase() + normCity.slice(1).toLowerCase()}`;
  }
  if (appendState && stateAbbr) {
    searchAddress += `, ${stateAbbr}`;
  }

  // Build validation address (with zip for URL scoring)
  let validationAddress = searchAddress;
  if (extractedZip) {
    validationAddress += ` ${extractedZip}`;
  }

  return { searchAddress, validationAddress };
}

interface ZillowSearchResult {
  url: string | null;
  confidence: "high" | "medium" | "low" | null;
  matchScore: number;
  matchMaxScore: number;
  matchFlags: string[];
  error?: string;
}

interface ZillowPropertyData {
  url: string | null;
  price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  rawStatus: string | null;
  status: string | null;
  statusDate: string | null;
  error?: string;
}

interface SerpApiResult {
  organic?: Array<{
    link?: string;
    title?: string;
  }>;
}

/**
 * Search for a Zillow URL matching the given address.
 * @param address - The search query address (may have zip removed for better Google results)
 * @param validationAddress - Optional full address including zip for URL validation scoring.
 *                            If omitted, uses `address` for both search and validation.
 */
export async function searchZillowUrl(address: string, validationAddress?: string): Promise<ZillowSearchResult> {
  const matchAddress = validationAddress || address;
  const apiKey = (await envvars.retrieve("BRIGHT_DATA_API_KEY")).value;
  const zone = (await envvars.retrieve("BRIGHT_DATA_SERP_ZONE")).value || "serp_api1";

  // Extract zip from validationAddress for more targeted queries
  const zipMatch = matchAddress.match(/\b(\d{5})\b/);
  const zip = zipMatch ? zipMatch[1] : "";
  const addrWithZip = zip ? `${address} ${zip}` : address;

  const searchQueries = [
    `site:zillow.com/homedetails "${addrWithZip}"`,
    `zillow ${addrWithZip}`,
    `site:zillow.com ${address}`,
  ];

  let bestFallback: ZillowSearchResult | null = null;

  for (let queryIndex = 0; queryIndex < searchQueries.length; queryIndex++) {
    const query = searchQueries[queryIndex];
    // Add brd_json=1 to get parsed JSON results from Bright Data
    const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&brd_json=1`;

    console.log(`Searching Zillow for: "${query}"`);

    try {
      const response = await fetch("https://api.brightdata.com/request", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          zone: zone,
          url: googleSearchUrl,
          format: "raw",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`SERP API error: ${response.status} - ${errorText}`);
        // Throw on rate limits and server errors so task-level retries kick in
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`SERP API rate limited/server error: ${response.status} - ${errorText}`);
        }
        throw new Error(`SERP API error: ${response.status} - ${errorText}`);
      }

      const responseText = await response.text();
      console.log(`SERP raw response (first 1000 chars): ${responseText.substring(0, 1000)}`);

      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        console.log(`SERP response is not JSON, might be HTML`);
        // Try to extract URLs from HTML response
        const zillowMatches = responseText.match(/https:\/\/www\.zillow\.com\/homedetails\/[^"'\s]+/g);
        if (zillowMatches && zillowMatches.length > 0) {
          const match = selectBestZillowLink(
            zillowMatches.map((link) => ({ link })),
            matchAddress
          );
          if (match) {
            console.log(`Found Zillow URL in HTML: ${match.url} (confidence: ${match.confidence}, score: ${match.score}/${match.maxScore}, flags: ${match.flags.join(", ") || "none"})`);
            // Early return on high confidence from first query
            if (queryIndex === 0 && match.confidence === "high") {
              return { url: match.url, confidence: match.confidence, matchScore: match.score, matchMaxScore: match.maxScore, matchFlags: match.flags };
            }
            if (!bestFallback || match.score > bestFallback.matchScore) {
              bestFallback = { url: match.url, confidence: match.confidence, matchScore: match.score, matchMaxScore: match.maxScore, matchFlags: match.flags };
            }
          }
        }
        continue;
      }

      const organic = data.organic || data.results || [];

      console.log(`SERP returned ${organic.length} results`);

      const candidates = organic
        .map((result: { link?: string; url?: string; title?: string }) => ({
          link: result.link || result.url || "",
          title: result.title || "",
        }))
        .filter((result: { link: string }) => result.link.includes("zillow.com") && result.link.includes("/homedetails/"));

      for (const result of candidates) {
        console.log(`  - ${result.title}: ${result.link}`);
      }

      if (candidates.length > 0) {
        const match = selectBestZillowLink(candidates, matchAddress);
        if (match) {
          console.log(`Best match: ${match.url} (confidence: ${match.confidence}, score: ${match.score}/${match.maxScore}, flags: ${match.flags.join(", ") || "none"})`);
          // Early return on high confidence from first query; otherwise keep searching
          if (queryIndex === 0 && match.confidence === "high") {
            return { url: match.url, confidence: match.confidence, matchScore: match.score, matchMaxScore: match.maxScore, matchFlags: match.flags };
          }
          if (!bestFallback || match.score > bestFallback.matchScore) {
            bestFallback = { url: match.url, confidence: match.confidence, matchScore: match.score, matchMaxScore: match.maxScore, matchFlags: match.flags };
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Zillow search error: ${message}`);
      // Rethrow rate limit / server errors so task retries can handle them
      if (message.includes("rate limited") || message.includes("server error")) {
        throw error;
      }
      return { url: null, confidence: null, matchScore: 0, matchMaxScore: 0, matchFlags: [], error: message };
    }
  }

  // Return the best result found across all queries, or no match
  if (bestFallback) {
    console.log(`Returning best match across queries: ${bestFallback.url} (score: ${bestFallback.matchScore})`);
    return bestFallback;
  }

  return { url: null, confidence: null, matchScore: 0, matchMaxScore: 0, matchFlags: [], error: "No Zillow listing found in search results" };
}

export async function scrapeZillowProperty(url: string): Promise<ZillowPropertyData> {
  const apiKey = (await envvars.retrieve("BRIGHT_DATA_API_KEY")).value;

  // Primary: Zillow Scraper API — single call, returns structured JSON
  try {
    const result = await scrapeViaZillowScraper(url, apiKey);

    if (result.status || result.price) {
      console.log(`Zillow Scraper succeeded for ${url}: status=${result.status}, price=${result.price}`);
      return result;
    }

    console.log(`Zillow Scraper returned no usable data for ${url}, falling back to Web Unlocker`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // Rethrow rate-limit/server errors — don't waste a Web Unlocker call
    if (message.includes("rate limited") || message.includes("server error")) {
      throw error;
    }
    console.log(`Zillow Scraper failed for ${url}: ${message} — falling back to Web Unlocker`);
  }

  // Fallback: Web Unlocker — 2 attempts max
  const zone = (await envvars.retrieve("BRIGHT_DATA_WEB_UNLOCKER_ZONE")).value || "web_unlocker2";
  const MAX_FALLBACK_ATTEMPTS = 2;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_FALLBACK_ATTEMPTS; attempt++) {
    try {
      const result = await scrapeViaWebUnlocker(url, apiKey, zone);

      if (result.status) {
        return result;
      }

      lastError = result.error || "No status extracted";
      if (attempt < MAX_FALLBACK_ATTEMPTS) {
        const delay = 5000 + Math.random() * 3000;
        console.log(`Web Unlocker attempt ${attempt}/${MAX_FALLBACK_ATTEMPTS} returned no status for ${url} — retrying in ${Math.round(delay / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      lastError = message;

      if (message.includes("rate limited") || message.includes("server error")) {
        throw error;
      }

      if (attempt < MAX_FALLBACK_ATTEMPTS) {
        const delay = 5000 + Math.random() * 3000;
        console.log(`Web Unlocker attempt ${attempt}/${MAX_FALLBACK_ATTEMPTS} failed for ${url}: ${message} — retrying in ${Math.round(delay / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`All scrape methods exhausted for ${url}. Last error: ${lastError}`);
}

function validateZillowHtml(html: string): { valid: boolean; reason: string; htmlLength: number } {
  const htmlLength = html.length;

  // Check 1: PerimeterX / captcha detection
  if (html.includes("px-captcha") || html.includes("_pxAppId")) {
    return { valid: false, reason: "PerimeterX captcha detected", htmlLength };
  }
  if (/<title[^>]*>Access Denied/i.test(html)) {
    return { valid: false, reason: "Access Denied page", htmlLength };
  }

  // Check 2: Length gate — real Zillow pages are 200KB+, blocked shells are <10KB
  if (htmlLength < 10000) {
    return { valid: false, reason: `HTML too short (${htmlLength} bytes)`, htmlLength };
  }

  // Check 3: Must contain at least one Zillow data marker
  const hasHomeStatus = html.includes('"homeStatus"');
  const hasClientCache = html.includes('"gdpClientCache"');
  const hasMetaDesc = /<meta\s+name=["']description["']/i.test(html);
  const hasPriceTestId = html.includes('data-testid="price"');

  if (!hasHomeStatus && !hasClientCache && !hasMetaDesc && !hasPriceTestId) {
    return { valid: false, reason: "No Zillow data markers found (empty shell)", htmlLength };
  }

  return { valid: true, reason: "ok", htmlLength };
}

async function scrapeViaWebUnlocker(
  url: string,
  apiKey: string,
  zone: string
): Promise<ZillowPropertyData> {
  const webUnlockerUrl = "https://api.brightdata.com/request";

  try {
    const response = await fetch(webUnlockerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        zone: zone,
        url: url,
        format: "raw",
        country: "us",
      }),
    });

    // Log response metadata for diagnostics
    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const luminatiError = response.headers.get("x-luminati-error");
    console.log(`Web Unlocker response: status=${response.status}, content-type=${contentType}, content-length=${contentLength}, x-luminati-error=${luminatiError || "none"}`);

    if (!response.ok) {
      const errorText = await response.text();
      // Throw specifically for rate limits so task retries kick in
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Web Unlocker rate limited/server error: ${response.status} - ${errorText}`);
      }
      throw new Error(`Web Unlocker error: ${response.status} - ${errorText}`);
    }

    const html = await response.text();

    // Validate HTML before parsing — detect blocked/empty responses
    const validation = validateZillowHtml(html);
    console.log(`HTML validation: valid=${validation.valid}, reason=${validation.reason}, length=${validation.htmlLength}`);

    if (!validation.valid) {
      console.log(`Blocked HTML preview (first 500 chars): ${html.substring(0, 500)}`);
      throw new Error(`Zillow blocked: ${validation.reason}`);
    }

    return parseZillowHtml(html, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // Rethrow rate limit / server errors and blocked errors so retries can handle them
    if (message.includes("rate limited") || message.includes("server error") || message.includes("Zillow blocked")) {
      throw error;
    }
    return {
      url,
      price: null,
      bedrooms: null,
      bathrooms: null,
      squareFeet: null,
      rawStatus: null,
      status: null,
      statusDate: null,
      error: message,
    };
  }
}

// --- Bright Data Zillow Scraper (structured data fallback) ---
// Uses the sync endpoint for single-URL requests. Falls back to polling if >1min.
// Docs: https://docs.brightdata.com/api-reference/web-scraper-api/synchronous-requests

const ZILLOW_DATASET_ID = "gd_lfqkr8wm13ixtbd8f5";

async function scrapeViaZillowScraper(
  url: string,
  apiKey: string,
): Promise<ZillowPropertyData> {
  const endpoint = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${ZILLOW_DATASET_ID}&include_errors=true&format=json`;

  console.log(`[Zillow Scraper fallback] Requesting structured data for: ${url}`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ url }]),
  });

  // Sync timeout — API returns snapshot_id, we poll for results
  if (response.status === 202) {
    const body = await response.json() as { snapshot_id?: string };
    const snapshotId = body.snapshot_id;
    if (!snapshotId) {
      throw new Error("Zillow Scraper returned 202 but no snapshot_id");
    }
    console.log(`[Zillow Scraper] Sync timed out, polling snapshot: ${snapshotId}`);
    return pollAndDownloadSnapshot(snapshotId, apiKey, url);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Zillow Scraper API error: ${response.status} - ${errorText}`);
  }

  const results = await response.json();
  const record = Array.isArray(results) ? results[0] : results;

  if (!record) {
    throw new Error("Zillow Scraper returned empty result array");
  }

  return mapScraperResult(record, url);
}

async function pollAndDownloadSnapshot(
  snapshotId: string,
  apiKey: string,
  url: string,
): Promise<ZillowPropertyData> {
  const MAX_POLLS = 12;
  const POLL_INTERVAL = 10_000; // 10s — total wait up to 2 minutes

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    const progressRes = await fetch(
      `https://api.brightdata.com/datasets/v3/progress/${snapshotId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );

    if (!progressRes.ok) {
      console.log(`[Zillow Scraper] Poll error: ${progressRes.status}`);
      continue;
    }

    const progress = await progressRes.json() as { status: string };
    console.log(`[Zillow Scraper] Snapshot ${snapshotId} status: ${progress.status} (poll ${i + 1}/${MAX_POLLS})`);

    if (progress.status === "ready") {
      const dataRes = await fetch(
        `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );

      if (!dataRes.ok) {
        throw new Error(`Zillow Scraper snapshot download failed: ${dataRes.status}`);
      }

      const results = await dataRes.json();
      const record = Array.isArray(results) ? results[0] : results;
      return mapScraperResult(record, url);
    }

    if (progress.status === "failed") {
      throw new Error(`Zillow Scraper snapshot failed: ${snapshotId}`);
    }
  }

  throw new Error(`Zillow Scraper snapshot polling timed out after ${MAX_POLLS * POLL_INTERVAL / 1000}s: ${snapshotId}`);
}

function mapScraperResult(data: Record<string, unknown>, url: string): ZillowPropertyData {
  if (!data || data.__error || data.error) {
    return {
      url,
      price: null,
      bedrooms: null,
      bathrooms: null,
      squareFeet: null,
      rawStatus: null,
      status: null,
      statusDate: null,
      error: `Zillow Scraper: ${(data?.__error || data?.error || "No data") as string}`,
    };
  }

  const rawStatus = (data.homeStatus || data.home_status || null) as string | null;
  const status = rawStatus ? mapPropertyStatus(rawStatus) : null;

  // Status date: prefer dateSold for sold properties, datePosted for active/pending
  let statusDate: string | null = null;
  if (data.dateSoldString) {
    statusDate = normalizeDate(String(data.dateSoldString));
  } else if (data.dateSold) {
    if (typeof data.dateSold === "number") {
      const ts = data.dateSold;
      const ms = ts > 9999999999 ? ts : ts * 1000;
      statusDate = normalizeDate(new Date(ms).toISOString());
    } else {
      statusDate = normalizeDate(String(data.dateSold));
    }
  } else if (data.datePosted) {
    statusDate = normalizeDate(String(data.datePosted));
  }

  // Price: could be number or formatted string
  let price: number | null = null;
  if (typeof data.price === "number") {
    price = data.price;
  } else if (typeof data.price === "string") {
    price = parsePrice(data.price);
  }

  const bedrooms = typeof data.bedrooms === "number" ? data.bedrooms : null;
  const bathrooms = typeof data.bathrooms === "number" ? data.bathrooms : null;
  const squareFeet = typeof data.livingArea === "number" ? data.livingArea
    : typeof data.living_area === "number" ? (data.living_area as number)
    : null;

  console.log(`[Zillow Scraper] Mapped: status=${status}, price=${price}, beds=${bedrooms}, baths=${bathrooms}, sqft=${squareFeet}, date=${statusDate}`);

  return {
    url: (data.url as string) || url,
    price,
    bedrooms,
    bathrooms,
    squareFeet,
    rawStatus,
    status,
    statusDate,
  };
}

function parseZillowHtml(html: string, url: string): ZillowPropertyData {
  const result: ZillowPropertyData = {
    url,
    price: null,
    bedrooms: null,
    bathrooms: null,
    squareFeet: null,
    rawStatus: null,
    status: null,
    statusDate: null,
  };

  try {
    // Extract price - look for JSON-LD or common patterns
    const priceMatch = html.match(/\$[\d,]+(?:\.\d{2})?/);
    if (priceMatch) {
      result.price = parsePrice(priceMatch[0]);
    }

    // Try to find structured data
    const jsonLdMatch = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
    );
    if (jsonLdMatch) {
      try {
        const jsonData = JSON.parse(jsonLdMatch[1]);
        if (jsonData["@type"] === "SingleFamilyResidence" || jsonData["@type"] === "Product") {
          if (jsonData.offers?.price) {
            result.price = parseFloat(jsonData.offers.price);
          }
          if (jsonData.numberOfRooms) {
            result.bedrooms = parseInt(jsonData.numberOfRooms);
          }
        }
      } catch {
        // JSON parse failed, continue with regex
      }
    }

    // Extract beds
    const bedsMatch = html.match(/(\d+)\s*(?:bd|bed|beds|bedroom|bedrooms)/i);
    if (bedsMatch) {
      result.bedrooms = parseInt(bedsMatch[1]);
    }

    // Extract baths
    const bathsMatch = html.match(/([\d.]+)\s*(?:ba|bath|baths|bathroom|bathrooms)/i);
    if (bathsMatch) {
      result.bathrooms = parseFloat(bathsMatch[1]);
    }

    // Extract sqft
    const sqftMatch = html.match(/([\d,]+)\s*(?:sqft|sq\s*ft|square\s*feet)/i);
    if (sqftMatch) {
      result.squareFeet = parseInt(sqftMatch[1].replace(/,/g, ""));
    }

    // --- Status extraction (layered approach) ---
    // Layer 1: homeStatus from embedded JSON (most reliable when present)
    const homeStatusMatch = html.match(/"homeStatus"\s*:\s*"([^"]+)"/i);
    if (homeStatusMatch) {
      result.rawStatus = homeStatusMatch[1].trim();
      result.status = mapPropertyStatus(result.rawStatus);
    }

    // Layer 1b: If homeStatus was found AND equals FOR_SALE, check listingSubType
    // for a pending/contingent override. Zillow sometimes reports homeStatus as
    // "FOR_SALE" even when the property is pending — listingSubType is more accurate.
    if (homeStatusMatch) {
      const homeVal = homeStatusMatch[1].trim().toUpperCase();
      if (homeVal === "FOR_SALE") {
        const isPendingSubType =
          /"isPending"\s*:\s*true/i.test(html) ||
          /"is_pending"\s*:\s*true/i.test(html);
        const isContingentSubType =
          /"contingentListingType"\s*:\s*"[^"]+"/i.test(html);

        if (isPendingSubType) {
          console.log(`Pending override: homeStatus="${result.rawStatus}" but isPending=true`);
          result.rawStatus = "PENDING";
          result.status = "Pending";
        } else if (isContingentSubType) {
          const contingentMatch = html.match(/"contingentListingType"\s*:\s*"([^"]+)"/i);
          console.log(`Contingent override: homeStatus="${result.rawStatus}" but contingentListingType="${contingentMatch?.[1]}"`);
          result.rawStatus = "CONTINGENT";
          result.status = "Active Contingent";
        }
      }
    }

    // Layer 2: <meta name="description"> — always present in SSR HTML.
    // Zillow meta descriptions follow the pattern: "{address} is pending."
    // or "{address} is currently listed for sale." etc.
    if (!result.status) {
      const metaDescMatch =
        html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
        html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
      if (metaDescMatch) {
        const desc = metaDescMatch[1].toLowerCase();
        if (desc.includes("is pending")) {
          result.rawStatus = "meta:pending";
          result.status = "Pending";
        } else if (desc.includes("is contingent") || desc.includes("contingent")) {
          result.rawStatus = "meta:contingent";
          result.status = "Active Contingent";
        } else if (
          desc.includes("was recently sold") ||
          desc.includes("was sold") ||
          desc.includes("last sold")
        ) {
          result.rawStatus = "meta:sold";
          result.status = "Sold";
        } else if (desc.includes("is off market") || desc.includes("off market")) {
          result.rawStatus = "meta:off_market";
          result.status = "Off Market";
        } else if (
          desc.includes("for sale") ||
          desc.includes("is currently listed") ||
          desc.includes("is listed")
        ) {
          result.rawStatus = "meta:for_sale";
          result.status = "Active";
        }
      }
    }

    // Layer 3: hdpTypeDimension (title-case display value, e.g. "ForSale", "Pending")
    if (!result.status) {
      const hdpTypeMatch = html.match(/"hdpTypeDimension"\s*:\s*"([^"]+)"/i);
      if (hdpTypeMatch) {
        const hdpType = hdpTypeMatch[1].trim();
        result.rawStatus = hdpType;
        result.status = mapPropertyStatus(hdpType);
      }
    }

    // Layer 4: HTML status elements (data-testid attributes on status badges)
    if (!result.status) {
      const htmlStatusPatterns = [
        /data-testid="(?:listing-status|gallery-status-pill)"[^>]*>[^<]*?<[^>]*>([^<]+)/i,
        /data-testid="(?:listing-status|gallery-status-pill)"[^>]*>([^<]+)/i,
        /class="[^"]*listing[-_]?status[^"]*"[^>]*>([^<]+)/i,
      ];
      for (const pattern of htmlStatusPatterns) {
        const match = html.match(pattern);
        if (match) {
          result.rawStatus = match[1].trim();
          result.status = mapPropertyStatus(result.rawStatus);
          break;
        }
      }
    }

    // Layer 5: Last resort — broad text matching
    if (!result.status) {
      if (html.includes("Off Market") || html.includes("off market")) {
        result.rawStatus = "Off Market";
        result.status = "Off Market";
      } else if (html.includes("For Sale") || html.includes("for sale")) {
        result.rawStatus = "For Sale";
        result.status = "Active";
      } else if (html.includes("Sold") || html.includes("sold")) {
        result.rawStatus = "Sold";
        result.status = "Sold";
      } else if (html.includes("Pending")) {
        result.rawStatus = "Pending";
        result.status = "Pending";
      } else if (html.includes("Contingent")) {
        result.rawStatus = "Contingent";
        result.status = "Active Contingent";
      }
    }

    // --- Status date extraction (best-effort, layered) ---
    // Zillow stores property data in gdpClientCache as escaped JSON.
    // Decode escaped quotes and unicode to make date fields searchable.
    const decoded = html
      .replace(/\\u0022/g, '"')
      .replace(/\\u002F/g, "/")
      .replace(/\\"/g, '"')
      .replace(/\\\\"/g, '"');

    // Search both raw html and decoded content for date fields
    const searchTargets = [decoded, html];

    // Layer 1: dateSold / dateSoldString (most reliable for sold properties)
    for (const target of searchTargets) {
      if (result.statusDate) break;
      const dateSoldMatch = target.match(/"dateSold(?:String)?"\s*:\s*"([^"]+)"/i);
      if (dateSoldMatch) {
        result.statusDate = normalizeDate(dateSoldMatch[1]);
      }
    }

    // Layer 2: dateSold as epoch: "dateSold":1234567890000
    if (!result.statusDate) {
      for (const target of searchTargets) {
        if (result.statusDate) break;
        const dateSoldEpoch = target.match(/"dateSold"\s*:\s*(\d{10,13})/i);
        if (dateSoldEpoch) {
          const ts = parseInt(dateSoldEpoch[1]);
          const ms = ts > 9999999999 ? ts : ts * 1000;
          const d = new Date(ms);
          result.statusDate = normalizeDate(d.toISOString());
        }
      }
    }

    // Layer 3: datePosted / datePostedString (listing date for active/pending)
    if (!result.statusDate) {
      for (const target of searchTargets) {
        if (result.statusDate) break;
        const datePostedMatch = target.match(/"datePosted(?:String)?"\s*:\s*"([^"]+)"/i);
        if (datePostedMatch) {
          result.statusDate = normalizeDate(datePostedMatch[1]);
        }
      }
    }

    // Layer 4: datePriceChanged (often the most recent activity date)
    if (!result.statusDate) {
      for (const target of searchTargets) {
        if (result.statusDate) break;
        const datePriceMatch = target.match(/"datePriceChanged"\s*:\s*(\d{10,13})/i);
        if (datePriceMatch) {
          const ts = parseInt(datePriceMatch[1]);
          const ms = ts > 9999999999 ? ts : ts * 1000;
          const d = new Date(ms);
          result.statusDate = normalizeDate(d.toISOString());
        }
      }
    }

    // Layer 5: listingDateTimeOnZillow
    if (!result.statusDate) {
      for (const target of searchTargets) {
        if (result.statusDate) break;
        const listingDateMatch = target.match(/"listingDateTimeOnZillow"\s*:\s*"([^"]+)"/i);
        if (listingDateMatch) {
          result.statusDate = normalizeDate(listingDateMatch[1]);
        }
      }
    }

    // Layer 6: priceHistory first entry date
    if (!result.statusDate) {
      for (const target of searchTargets) {
        if (result.statusDate) break;
        const priceHistDateMatch = target.match(/"priceHistory"\s*:\s*\[.*?"date"\s*:\s*"([^"]+)"/i);
        if (priceHistDateMatch) {
          result.statusDate = normalizeDate(priceHistDateMatch[1]);
        }
        // Also try epoch in priceHistory
        const priceHistEpoch = target.match(/"priceHistory"\s*:\s*\[.*?"time"\s*:\s*(\d{10,13})/i);
        if (!result.statusDate && priceHistEpoch) {
          const ts = parseInt(priceHistEpoch[1]);
          const ms = ts > 9999999999 ? ts : ts * 1000;
          const d = new Date(ms);
          result.statusDate = normalizeDate(d.toISOString());
        }
      }
    }

    // Layer 7: "Sold on MM/DD/YYYY" or "Sold MM/DD/YYYY" in text
    if (!result.statusDate) {
      const soldOnMatch = decoded.match(/Sold\s+(?:on\s+)?(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (soldOnMatch) {
        result.statusDate = normalizeDate(soldOnMatch[1]);
      }
    }

    // Layer 8: JSON-LD datePublished
    if (!result.statusDate && jsonLdMatch) {
      try {
        const jsonData = JSON.parse(jsonLdMatch[1]);
        if (jsonData.datePublished) {
          result.statusDate = normalizeDate(jsonData.datePublished);
        }
      } catch {
        // Already tried parsing above, ignore
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Parse error";
  }

  return result;
}

/** Normalize a date string to YYYY-MM-DD. Returns null if unparseable. */
function normalizeDate(raw: string): string | null {
  // Already YYYY-MM-DD
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // MM/DD/YYYY
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, "0");
    const day = slashMatch[2].padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }

  // Try Date.parse as last resort (handles ISO8601 variants, "March 15, 2026", etc.)
  const parsed = Date.parse(raw);
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function parsePrice(priceString: string): number | null {
  const cleaned = priceString.replace(/[$,]/g, "");
  const value = parseFloat(cleaned);
  return isNaN(value) ? null : value;
}

function mapPropertyStatus(status: string): string {
  const normalized = status.toLowerCase().trim();

  // Exact Zillow enum values (uppercase from homeStatus field)
  if (normalized === "for_sale" || normalized === "forsale") return "Active";
  if (normalized === "pending") return "Pending";
  if (normalized === "recently_sold") return "Sold";
  if (normalized === "off_market") return "Off Market";
  if (normalized === "other") return "Off Market";
  if (normalized === "coming_soon") return "Coming Soon";
  if (normalized === "pre_foreclosure" || normalized === "preforeclosure") return "Pre-Foreclosure";
  if (normalized === "foreclosure") return "Foreclosure";
  if (normalized === "auction") return "Auction";

  // Fuzzy matching for display values and edge cases
  if (normalized.includes("for sale")) return "Active";
  if (normalized.includes("pending")) return "Pending";
  if (normalized.includes("contingent")) return "Active Contingent";
  if (normalized.includes("coming soon")) return "Coming Soon";
  if (normalized.includes("off market")) return "Off Market";
  if (normalized.includes("recently sold")) return "Sold";
  if (normalized.includes("pre") && normalized.includes("foreclos")) return "Pre-Foreclosure";
  if (normalized.includes("foreclos")) return "Foreclosure";
  if (normalized.includes("auction")) return "Auction";
  if (normalized.includes("sold")) return "Sold";

  return status;
}

export type { ZillowPropertyData, ZillowSearchResult };

// --- Address validation and matching ---

interface MatchResult {
  url: string;
  confidence: "high" | "medium" | "low";
  score: number;
  maxScore: number;
  flags: string[];
}

interface ParsedZillowAddress {
  houseNumber: string | null;
  streetTokens: string[];
  unit: string | null;
  cityTokens: string[];
  state: string | null;
  zip: string | null;
  raw: string;
}

interface ParsedInputAddress {
  houseNumber: string | null;
  streetTokens: string[];
  unit: string | null;
  zip: string | null;
}

const STREET_TYPES = new Set([
  "st", "street", "ave", "avenue", "rd", "road", "dr", "drive",
  "blvd", "boulevard", "ln", "lane", "ct", "court", "pl", "place",
  "ter", "terrace", "cir", "circle", "hwy", "highway", "way", "loop",
  "trl", "trail", "path", "pkwy", "parkway", "run", "pass", "xing",
  "crossing", "park", "bend", "cv", "cove", "pt", "point",
]);

const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw",
  "north", "south", "east", "west"]);

const STATE_ABBRS = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in",
  "ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv",
  "nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn",
  "tx","ut","vt","va","wa","wv","wi","wy","dc",
]);

/**
 * Parse a Zillow homedetails URL to extract address components.
 * URL format: /homedetails/{address-slug}/{zpid}_zpid/
 * Example: /homedetails/4313-Valley-Brook-Dr-Fort-Worth-TX-76036/459612012_zpid/
 */
function parseZillowUrl(url: string): ParsedZillowAddress {
  const result: ParsedZillowAddress = {
    houseNumber: null, streetTokens: [], unit: null, cityTokens: [], state: null, zip: null, raw: url,
  };

  const match = url.match(/\/homedetails\/([^/]+)\/\d+_zpid/);
  if (!match) return result;

  const slug = match[1];
  const tokens = slug.split("-").map((t) => t.toLowerCase()).filter(Boolean);

  if (tokens.length === 0) return result;

  // Extract zip (last token if 5 digits)
  if (/^\d{5}$/.test(tokens[tokens.length - 1])) {
    result.zip = tokens.pop()!;
  }

  // Extract state (last remaining token if 2-letter state abbr)
  if (tokens.length > 0 && STATE_ABBRS.has(tokens[tokens.length - 1])) {
    result.state = tokens.pop()!;
  }

  // Extract house number (first token if starts with digit)
  if (tokens.length > 0 && /^\d/.test(tokens[0])) {
    result.houseNumber = tokens.shift()!;
  }

  // Remaining tokens: split into street and city at the street type boundary
  // e.g., ["valley", "brook", "dr", "fort", "worth"] → street=["valley","brook"], city=["fort","worth"]
  let streetTypeIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (STREET_TYPES.has(tokens[i])) {
      streetTypeIndex = i;
      break;
    }
  }

  const UNIT_MARKERS = new Set(["unit", "apt", "ste", "suite", "lot", "bldg", "#"]);

  if (streetTypeIndex >= 0) {
    // Everything up to and including the street type is the street
    result.streetTokens = tokens.slice(0, streetTypeIndex + 1);
    let afterStreet = streetTypeIndex + 1;

    // Detect unit: explicit marker (unit, apt, ste, lot, etc.) + value
    if (afterStreet < tokens.length && UNIT_MARKERS.has(tokens[afterStreet])) {
      afterStreet++; // skip marker
      if (afterStreet < tokens.length) {
        result.unit = tokens[afterStreet];
        afterStreet++; // skip value
      }
    }
    // Detect unit: short alphanumeric token right after street type (e.g., "14b", "c", "301")
    // These are unit/lot identifiers without an explicit marker
    else if (afterStreet < tokens.length && /^\d+[a-z]?$|^[a-z]\d*$/.test(tokens[afterStreet]) && tokens[afterStreet].length <= 4) {
      result.unit = tokens[afterStreet];
      afterStreet++;
    }

    result.cityTokens = tokens.slice(afterStreet);
  } else {
    // No street type found — treat all as street tokens
    result.streetTokens = tokens;
  }

  return result;
}

/**
 * Parse the input address string to extract house number, street tokens, and zip.
 * Input format: "4313 Valley Drive 79707" or "4313 Valley Drive, City, State"
 */
function parseInputAddress(address: string): ParsedInputAddress {
  const cleaned = address.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const tokens = cleaned.split(" ").filter(Boolean);

  let houseNumber: string | null = null;
  let zip: string | null = null;
  const streetTokens: string[] = [];

  // Extract zip code (5-digit number, usually at the end)
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^\d{5}(-\d{4})?$/.test(tokens[i])) {
      zip = tokens[i].substring(0, 5);
      tokens.splice(i, 1);
      break;
    }
  }

  // Extract house number (first token with digits)
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d/.test(tokens[i])) {
      houseNumber = tokens[i].toLowerCase();
      tokens.splice(i, 1);
      break;
    }
  }

  // Remaining tokens are street name components
  // Stop collecting when we hit a city name (heuristic: after a street type)
  const UNIT_MARKERS = new Set(["unit", "apt", "ste", "suite", "lot", "bldg", "#"]);
  let unit: string | null = null;
  let pastStreetType = false;
  for (let i = 0; i < tokens.length; i++) {
    const lower = tokens[i].toLowerCase();
    if (pastStreetType) {
      // Check for unit marker after street type (e.g., "Unit #E", "Apt 2301")
      if (UNIT_MARKERS.has(lower.replace(/^#/, ""))) {
        // Next token is the unit value
        if (i + 1 < tokens.length) {
          unit = tokens[i + 1].toLowerCase().replace(/^#/, "");
        }
      }
      break;
    }
    // Skip directionals and state names at the end
    if (STATE_ABBRS.has(lower) || (lower.length > 2 && DIRECTIONALS.has(lower) && streetTokens.length > 0)) {
      continue;
    }
    // Detect inline unit markers (e.g., "2422 Navigation Boulevard Unit #E 77003")
    if (UNIT_MARKERS.has(lower.replace(/^#/, "")) && streetTokens.length > 0) {
      if (i + 1 < tokens.length) {
        unit = tokens[i + 1].toLowerCase().replace(/^#/, "");
      }
      break; // stop collecting street tokens
    }
    streetTokens.push(lower);
    if (STREET_TYPES.has(lower)) {
      pastStreetType = true;
    }
  }

  return { houseNumber, streetTokens, unit, zip };
}

/**
 * Normalize a street token to its canonical short form for comparison.
 * "street" → "st", "drive" → "dr", etc.
 */
function normalizeStreetToken(token: string): string {
  const map: Record<string, string> = {
    street: "st", avenue: "ave", road: "rd", drive: "dr",
    boulevard: "blvd", lane: "ln", court: "ct", place: "pl",
    terrace: "ter", circle: "cir", highway: "hwy", trail: "trl",
    parkway: "pkwy", crossing: "xing", cove: "cv", point: "pt",
    north: "n", south: "s", east: "e", west: "w",
    northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  };
  return map[token] || token;
}

/**
 * Score how well a Zillow URL matches the input address.
 * Returns score breakdown and flags.
 */
function validateAddressMatch(
  input: ParsedInputAddress,
  zillow: ParsedZillowAddress,
): { score: number; maxScore: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;
  const maxScore = 11; // 4 (house) + 3 (street) + 3 (zip) + 1 (homedetails)

  // Always +1 for being a /homedetails/ link
  score += 1;

  // --- House number: 4 points ---
  if (!input.houseNumber) {
    flags.push("NO_HOUSE_NUMBER");
    // Give partial credit since we can't validate
    score += 1;
  } else if (zillow.houseNumber === input.houseNumber) {
    score += 4;
  } else {
    flags.push(`HOUSE_NUM_MISMATCH:${input.houseNumber}→${zillow.houseNumber || "none"}`);
  }

  // --- Street name tokens: 3 points ---
  if (input.streetTokens.length > 0 && zillow.streetTokens.length > 0) {
    // Normalize all tokens for comparison (drive→dr, street→st, etc.)
    const inputNorm = input.streetTokens
      .filter((t) => !DIRECTIONALS.has(t))
      .map(normalizeStreetToken);
    const zillowNorm = zillow.streetTokens
      .filter((t) => !DIRECTIONALS.has(t))
      .map(normalizeStreetToken);

    // Count overlap between input and zillow street content tokens (both directions)
    const inputContent = inputNorm.filter((t) => !STREET_TYPES.has(t));
    const zillowContent = zillowNorm.filter((t) => !STREET_TYPES.has(t));

    let contentMatches = 0;
    for (const token of inputContent) {
      if (zillowContent.includes(token)) {
        contentMatches++;
      }
    }

    // Use Jaccard-like ratio: matches / union to catch extra tokens in either direction
    // e.g., input=["valley"] zillow=["valley","brook"] → 1/2 = 0.5 (not 1/1 = 1.0)
    const unionSize = new Set([...inputContent, ...zillowContent]).size;
    const contentRatio = unionSize > 0 ? contentMatches / unionSize : 0;

    // Also check street type match (dr vs st vs ln etc.)
    const inputType = inputNorm.find((t) => STREET_TYPES.has(t));
    const zillowType = zillowNorm.find((t) => STREET_TYPES.has(t));
    const typeMatch = !inputType || !zillowType || inputType === zillowType;

    if (contentRatio >= 0.75 && typeMatch) {
      score += 3;
    } else if (contentRatio >= 0.75) {
      score += 2;
      flags.push(`STREET_TYPE_MISMATCH:${inputType}→${zillowType}`);
    } else if (contentRatio >= 0.5) {
      score += 1;
      flags.push("STREET_PARTIAL_MATCH");
    } else {
      flags.push(`STREET_MISMATCH:${inputContent.join("+")}→${zillowContent.join("+")}`);
    }
  } else if (input.streetTokens.length === 0) {
    flags.push("NO_STREET_TOKENS");
  } else {
    flags.push("ZILLOW_NO_STREET_TOKENS");
  }

  // --- Zip code: 3 points ---
  if (input.zip && zillow.zip) {
    if (input.zip === zillow.zip) {
      score += 3;
    } else {
      flags.push(`ZIP_MISMATCH:${input.zip}→${zillow.zip}`);
    }
  } else if (!input.zip) {
    flags.push("NO_INPUT_ZIP");
    score += 1; // Partial credit
  }

  // --- Unit mismatch check (flag, no points) ---
  // If the Zillow URL has a unit but the input doesn't, this is likely a different listing
  if (zillow.unit && !input.unit) {
    flags.push(`UNIT_IN_URL:${zillow.unit}`);
  } else if (input.unit && zillow.unit && input.unit !== zillow.unit) {
    flags.push(`UNIT_MISMATCH:${input.unit}→${zillow.unit}`);
  }

  return { score, maxScore, flags };
}

/**
 * Select the best Zillow link from search results using address component validation.
 * Returns null if no candidate meets the minimum confidence threshold.
 */
function selectBestZillowLink(
  candidates: Array<{ link: string; title?: string }>,
  address: string
): MatchResult | null {
  if (candidates.length === 0) {
    return null;
  }

  const input = parseInputAddress(address);

  let bestMatch: MatchResult | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const link = candidate.link || "";
    if (!link.includes("/homedetails/")) continue;

    const zillow = parseZillowUrl(link);
    const { score, maxScore, flags } = validateAddressMatch(input, zillow);

    // Hard reject: wrong house number = wrong property, always
    if (flags.some((f) => f.startsWith("HOUSE_NUM_MISMATCH"))) {
      console.log(`  Rejecting ${link}: ${flags.find((f) => f.startsWith("HOUSE_NUM_MISMATCH"))}`);
      continue;
    }

    // Determine confidence
    let confidence: "high" | "medium" | "low";
    if (score >= 8 && !flags.some((f) => f.startsWith("STREET_MISMATCH") || f.startsWith("STREET_PARTIAL_MATCH") || f.startsWith("STREET_TYPE_MISMATCH") || f.startsWith("ZIP_MISMATCH") || f.startsWith("UNIT_IN_URL") || f.startsWith("UNIT_MISMATCH"))) {
      confidence = "high";
    } else if (score >= 5) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    console.log(`  Candidate: ${link} → score=${score}/${maxScore}, confidence=${confidence}, flags=[${flags.join(", ")}]`);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { url: link, confidence, score, maxScore, flags };
    }
  }

  // Minimum threshold: reject low-confidence matches entirely
  // Score < 5 means too many address components don't match
  if (bestMatch && bestMatch.score < 5) {
    console.log(`Rejecting best match (score ${bestMatch.score}/${bestMatch.maxScore} < 5): ${bestMatch.url} — flags: ${bestMatch.flags.join(", ")}`);
    return null;
  }

  return bestMatch;
}
