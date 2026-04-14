# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bulk Zillow property scraping for the **non-PC report** running on trigger.dev v3. Fetches a Zoho Analytics report, searches for Zillow URLs via Bright Data SERP API, scrapes property details, updates Zoho CRM records with high-confidence matches, and writes all results to Google Sheets.

This project is structurally similar to `zillow-bulk-pc` but operates on a different (larger) report and includes Zoho CRM write-back for high-confidence matches.

## Commands

```bash
# Install dependencies
npm install

# Start local dev server (connects to trigger.dev cloud)
npm run dev

# Deploy to trigger.dev production
npm run deploy

# Type check
npm run typecheck
```

## Architecture

```
trigger.config.ts          # trigger.dev configuration
src/
  jobs/
    zillow-non-pc-report.ts  # Main task definitions (scheduled + manual)
  lib/
    zillow.ts              # Bright Data SERP search + Zillow Scraper + Web Unlocker scraping
    zoho.ts                # Zoho CRM Bulk Read API v8 + OAuth + record updates
    zoho-analytics.ts      # Zoho Analytics report export (configurable via env vars)
    google-sheets.ts       # Google Sheets API (zero-dependency JWT auth)
```

### Task Flow

1. **zillow-non-pc-report** (scheduled cron, Wednesdays 6 AM Central) — Fetches non-PC report from Zoho Analytics, processes all properties with 30 concurrent workers
2. **manual-non-pc-report** (manual trigger) — Same flow but supports `maxRecords` limit for testing

### Key Difference from PC Version

- **Zoho CRM Updates**: High-confidence matches automatically update the Zoho CRM record with Zillow URL, price, beds, baths, sqft, and property status
- **Configurable Report**: Workspace and view IDs are env vars (`ZOHO_ANALYTICS_WORKSPACE_ID`, `ZOHO_ANALYTICS_VIEW_ID`) instead of hardcoded
- **Larger Report**: maxDuration set to 4 hours (14400s) to handle the bigger dataset

### Zillow Scraping Pipeline

For each property:
1. Preprocess address (title-case, strip zips, deduplicate city/state)
2. Search Google via Bright Data SERP with 3 progressive queries
3. Score results using 11-point address matching system
4. Scrape via Bright Data Zillow Scraper API (primary) or Web Unlocker (fallback)
5. Post-scrape address validation
6. Update Zoho CRM (high-confidence only)

### External Dependencies

- **Zoho Analytics**: Report export via REST API
- **Zoho CRM**: Record updates via v2 API
- **Bright Data**: SERP API, Zillow Scraper API, Web Unlocker
- **Google Sheets**: Results output via Sheets API v4

## Environment Variables

Set in trigger.dev dashboard (Environment Variables section):

| Variable | Purpose |
|---|---|
| `BRIGHT_DATA_API_KEY` | Bright Data API key |
| `BRIGHT_DATA_SERP_ZONE` | SERP zone (default: `serp_api1`) |
| `BRIGHT_DATA_WEB_UNLOCKER_ZONE` | Web Unlocker zone (default: `web_unlocker2`) |
| `ZOHO_CLIENT_ID` | Zoho OAuth client ID |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth client secret |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM refresh token |
| `ZOHO_ANALYTICS_REFRESH_TOKEN` | Zoho Analytics refresh token (falls back to CRM token) |
| `ZOHO_MODULE` | CRM module name (default: `Orders`) |
| `ZOHO_ORG_ID` | Zoho org ID for Analytics API |
| `ZOHO_ANALYTICS_WORKSPACE_ID` | Analytics workspace ID for the non-PC report |
| `ZOHO_ANALYTICS_VIEW_ID` | Analytics view ID for the non-PC report |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google service account email |
| `GOOGLE_PRIVATE_KEY` | Google service account private key |
| `GOOGLE_SPREADSHEET_ID` | Target Google Spreadsheet ID |

## Zoho CRM Field Mappings

Updates write to: `Zillow_URL`, `List_Price`, `Bedrooms`, `Bathrooms`, `Square_Feet`, `Property_Status`.
