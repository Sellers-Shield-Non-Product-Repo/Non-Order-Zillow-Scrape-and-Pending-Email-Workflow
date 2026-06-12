# Non-Order Zillow Scrape & Pending Email Workflow

Automated weekly job that scrapes Zillow listing data for properties on the
**non-HSLP-order report**, writes the results back into Zoho CRM, and kicks off
a staggered "new pending" seller-email workflow. Runs on [Trigger.dev](https://trigger.dev) v3.

GitHub: `morganadams-blip/Non-Order-Zillow-Scrape-and-Pending-Email-Workflow`
(directory still named `zillow-bulk-non-PC` locally).

---

## What it does

Each run:

1. **Pulls the report** of non-order properties from Zoho Analytics.
2. **Finds each property's Zillow listing** via Bright Data's Google SERP API,
   scoring candidate URLs against the input address.
3. **Scrapes listing details** (status, price, beds, baths, sqft) via Bright
   Data's Zillow Scraper API, with a Web Unlocker HTML fallback.
4. **Updates Zoho CRM** for high-confidence matches.
5. **Triggers the pending-email workflow** for properties that just went
   `Pending` — stamping a Zoho field that fires a seller email, spread out over
   business hours so emails don't all send at once.
6. **Writes results to Google Sheets** (two dated tabs per run) and **posts a
   summary to Slack** (`#automation-reports`).

This is the sibling of the `zillow-bulk-pc` project. The key differences here:
it operates on a larger, configurable report, writes back to Zoho CRM, and owns
the pending-email workflow.

---

## Architecture

```
trigger.config.ts            # Trigger.dev config (maxDuration 4h for the large dataset)
src/
  jobs/
    zillow-non-pc-report.ts   # Task definitions (scheduled + manual) and orchestration
  lib/
    zillow.ts                 # SERP search, address scoring, Zillow scraping + HTML parsing
    zoho.ts                   # Zoho CRM read/update + OAuth
    zoho-analytics.ts         # Zoho Analytics report export
    google-sheets.ts          # Google Sheets output (zero-dependency JWT auth)
    slack.ts                  # Slack run-summary webhook post
    scheduling.ts             # Random business-hours scheduling for pending emails
```

### Tasks

| Task | Type | Purpose |
|---|---|---|
| `zillow-non-pc-report` | scheduled | Main run — **Mondays 6 AM `America/Chicago`** (`0 6 * * 1`). Processes the full report in 8 parallel batches and records a weekly-summary row. |
| `manual-non-pc-report` | manual | Same flow for testing. Supports `maxRecords`, `numBatches`, and `recordWeekly` payload options. |
| `property-batch-worker` | child | Processes one batch slice (~20 concurrent workers, 500 ms stagger). |
| `update-pending-email-offer` | child (delayed) | Stamps `SST_Pending_Email_Offer` at a randomized business-hour time. Re-checks gating conditions before writing. |
| `probe-hslp-fields` | manual/diagnostic | One-off probe to discover Zoho API field names. |

---

## The Zillow matching pipeline

For each property (`checkPropertyInline`):

1. **Reuse cached URL** if Zoho already has a `zillow.com/homedetails/` link
   (scored as high confidence, skips search).
2. **Preprocess the address** — title-case, strip zips, drop periods/`#`,
   deduplicate embedded city/state (`preprocessSearchAddress`).
3. **Search Google** via Bright Data SERP with 3 progressive queries
   (`site:zillow.com/homedetails "addr"` → `zillow addr` → `site:zillow.com addr`).
4. **Score each candidate URL** out of **11 points**
   (`validateAddressMatch`): `+1` homedetails link, `+4` house number, `+3`
   street tokens, `+3` zip. Confidence: **high** = score ≥ 8 with no mismatch
   flags, **medium** = ≥ 5, **low** = < 5 (rejected). A house-number mismatch is
   a hard reject.
5. **Scrape the listing** — Zillow Scraper API first, Web Unlocker HTML fallback
   (with block detection: PerimeterX, length gate, data-marker checks).
6. **Post-scrape validation** — reject if the scraped URL's house number no
   longer matches the input. Downgrade `Sold` listings from high → medium.

Status is normalized to: `Active`, `Pending`, `Active Contingent`, `Sold`,
`Off Market`, `Coming Soon`, `Pre-Foreclosure`, `Foreclosure`, `Auction`.
Note the pending/contingent override: Zillow often reports `homeStatus:
FOR_SALE` for listings that are actually under contract, so `isPending` /
`contingentListingType` signals take precedence.

---

## The pending-email workflow

When a high-confidence scrape returns status `Pending`, the job considers
stamping the Zoho DateTime field `SST_Pending_Email_Offer`. Populating that
field triggers an outbound seller email in Zoho (offering an HSLP order).

**Gating** — the stamp only happens if BOTH are currently empty:
- `SST_Pending_Email_Offer` (don't email twice)
- `HSLP_upsell_purchased_at` (don't email a seller who already ordered HSLP)

Both are read in a single `getRecordFields` call.

**Staggering** — rather than stamping immediately, the job schedules a delayed
`update-pending-email-offer` child task at a **random business-hour moment over
the next ~36 hours** (8 AM–6 PM Central, see `pickBusinessHourDate`), so the
resulting emails trickle out instead of blasting at once.

**Fail-closed re-check** — the delayed task re-reads both gating fields right
before writing (state may have changed during the delay). If the re-check fails
for any reason, it aborts rather than risk a wrong email.

---

## Zoho CRM field mappings

High-confidence matches write to:

`Zillow_URL`, `List_Price`, `Bedrooms`, `Bathrooms`, `Square_Feet`,
`Property_Status`, `Property_Status_Updated`.

CRM update failures are logged but never fail the property check.

---

## Outputs

**Google Sheets** — two dated tabs per run ("High Confidence …" and
"Review Queue …"), plus a persistent week-over-week summary row (scheduled runs
only). Old report tabs are **pruned at the start of every run**, keeping the most
recent `SHEET_MAX_REPORT_TABS` (default 10) — each run adds ~750k cells and
Sheets caps a workbook at 10M cells.

**Slack** (`#automation-reports`) — posts at the end of every run: total checked,
high-confidence count + %, new status updates with a per-status breakdown, and
count of new pendings scheduled. The Slack post is isolated from the sheet
write, so a spreadsheet failure still posts a summary (with a ⚠️ note).

---

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Local dev server (connects to Trigger.dev cloud)
npm run deploy     # Deploy to Trigger.dev production
npm run typecheck  # tsc --noEmit
```

To test against a small slice, trigger `manual-non-pc-report` with
`{ "maxRecords": 20 }`.

---

## Environment variables

Set in the Trigger.dev dashboard (Environment Variables). See `.env.example`.

| Variable | Purpose |
|---|---|
| `BRIGHT_DATA_API_KEY` | Bright Data API key |
| `BRIGHT_DATA_SERP_ZONE` | SERP zone (default `serp_api1`) |
| `BRIGHT_DATA_WEB_UNLOCKER_ZONE` | Web Unlocker zone (default `web_unlocker2`) |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | Zoho OAuth app credentials |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM refresh token |
| `ZOHO_ANALYTICS_REFRESH_TOKEN` | Zoho Analytics refresh token (falls back to CRM token) |
| `ZOHO_MODULE` | CRM module name (default `Orders`) |
| `ZOHO_ORG_ID` | Zoho org ID for the Analytics API |
| `ZOHO_ANALYTICS_WORKSPACE_ID` | Analytics workspace ID for the non-PC report |
| `ZOHO_ANALYTICS_VIEW_ID` | Analytics view ID for the non-PC report |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google service account email |
| `GOOGLE_PRIVATE_KEY` | Google service account private key |
| `GOOGLE_SPREADSHEET_ID` | Target Google Spreadsheet ID |
| `SLACK_AUTOMATION_REPORTS_WEBHOOK_URL` | Incoming webhook for `#automation-reports` |
| `SHEET_MAX_REPORT_TABS` | (optional) Max dated report tabs to retain; default 10 |

---

## External dependencies

- **Zoho Analytics** — source report (REST export)
- **Zoho CRM** — write-back of listing data + the pending-email field
- **Bright Data** — SERP API, Zillow Scraper API, Web Unlocker
- **Google Sheets** — results output (Sheets API v4)
- **Slack** — run summaries
