# Prospecting module — plan

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Status: **PLAN, nothing built** (2026-09-24). Grilled with Hein on 2026-09-24; the rulings under "Settled" are closed and are not to be re-opened by an implementer.*

## Why

GoHighLevel's agency Prospecting tool (white-labelled analyzemy.business) was the hook of CrestaHQ's own outreach: a per-business audit report with a share link, and the report's worst finding as the opening line. Since GHL was stopped the ApexSignal pipeline half-died: sourcing still runs (`scripts/prospecting/source_cron.sh`, every 10 min, 5,715 rows in `docs/prospects_all.csv`), but sending tagged GHL contacts to fire GHL workflows and the reply inbox was GHL. Last send 2026-07-26; last "interested" replies 2026-09-08 have no owner.

This module makes the whole loop a LeadStack feature so (a) CrestaHQ prospects again and (b) every buyer of the template gets a Prospecting tool that is ahead of GHL's, because it includes AI visibility, which Vendasta only added to its Snapshot report in 2026 and GHL has not.

## Settled (Hein, 2026-09-24)

1. **Sub-account scoped, agency gated.** `prospectingEnabledByAgency`, off by default, in `PLAN_GATE_KEYS`. CrestaHQ runs it in its house sub-account (#1000). A client that sells B2B can be enabled too; that is the resale story.
2. **All six GHL sections plus the 2026 sections** (list below). Explicitly NOT built: backlink counts, an llms.txt score (no crawler requests it), a single blended "SEO score".
3. **ApexGEO is called, not copied.** Site health, schema, Core Web Vitals, AI-crawler access and AI visibility come from ApexGEO's public API on a user-provided `APEXGEO_API_KEY`. Not connected renders the section as "Not connected — add an ApexGEO key". Same shape as every other credential in this template.
4. **Reports are explicit and quota-capped.** Operator selects prospects and clicks Generate. One QStash job per prospect. A per-sub-account monthly report quota lives beside the existing gates in the Manage dialog. Mystery-shop sections are a separate, confirmed action because they touch a real business.
5. **One sourcing door.** Get Leads is un-parked and gains a persisted prospect list. ApexSignal keeps sourcing for us and pushes rows into #1000 through the public API. Outreach, reports and the approach guard only ever see contacts.
6. **Bridge stays an add-on.** Nothing here depends on the WhatsApp bridge.

## Report sections

| # | Section | Source | Cost owner | GHL has it |
|---|---|---|---|---|
| 1 | Business details (name, phone, address, hours, categories, website) | Outscraper row already returned by Get Leads | agency Outscraper key | yes |
| 2 | Google Business Profile completeness (claimed, photos, hours, description, posts, Q&A) | Outscraper row (fields already in `leads_n_contacts`); no GBP OAuth for a prospect | Outscraper | yes |
| 3 | Reputation (rating, review count, velocity last 90 d, owner reply rate) | Outscraper reviews sample (`reviews_limit` small) | Outscraper | yes |
| 4 | Listings / NAP consistency (Facebook page, Bing Places, Yellow Pages SA, Brabys, Cylex) | own HTTP checks, name+phone match, no paid citation API | none | yes |
| 5 | Website performance (Core Web Vitals mobile, HTTPS, mobile viewport) | ApexGEO audit (PageSpeed inside it) | ApexGEO key | yes |
| 6 | Tech stack (CMS, builder, analytics, chat widget, booking widget) | own fingerprinting from the fetched HTML using the open-source Wappalyzer rule set, top ~40 rules only | none | yes |
| 7 | **AI-agent readiness**: LocalBusiness schema, meta, robots.txt allow/deny for GPTBot, ClaudeBot, PerplexityBot, Google-Extended | ApexGEO audit decomposition | ApexGEO key | no |
| 8 | **AI answer-engine presence**: is the business named for "best {niche} in {city}" across Google AI Overview + ChatGPT + Perplexity + Gemini, with share of voice against the top 3 named competitors | ApexGEO brand mentions / share-of-voice | ApexGEO key | no |
| 9 | **Ads running**: Meta Ad Library + Google Ads Transparency lookups by page/domain | own fetch, public, no key | none | no |
| 10 | **Lead capture on site**: WhatsApp click-to-chat link, booking widget, form, phone tel: link, chat widget | own check on rendered HTML (Firecrawl scrape already in the repo) | Firecrawl key | no |
| 11 | **Speed-to-lead mystery shop** (separate action): submit their contact form or place a call from the sub-account's number, time the first response; rand value of a missed lead from an editable per-niche job value | LeadStack's own comms rails | Twilio/Vapi | no |
| 12 | **WhatsApp responsiveness** (separate action): message the listed number from the sub-account's WhatsApp sender, time the reply | WhatsApp Cloud sender | Meta | no |

Headline of the report = the single worst finding, ranked by a fixed severity table (no site > no HTTPS > not in any AI answer > no GBP claim > slow mobile > no WhatsApp CTA > …). That sentence is what the outreach merge tag uses.

Report page: `/r/{shareId}`, public, non-enumerating id, branded from agency Company Settings exactly like the GHL share links (logo, colours, agency name, CTA to the agency's booking page). PDF export is v2.

## Shape

### Data (all tenant docs carry `agencyId`, `subAccountId`, `createdByUid`)

- `prospectLists/{listId}` — name, query (type, place, radius), count, createdAt. One per Get Leads search the operator saves.
- `contacts/{id}` — prospects ARE contacts. `source: "prospecting"`, tags `["prospecting", "<batch>"]`, plus a `prospecting` map: `listId`, `placeId`, `website`, `rating`, `reviewsCount`, `category`, `approachedAt`, `lastReportId`.
- `prospectReports/{reportId}` — contactId, status (`queued` → `running` → `ready` | `failed`), `sections[]` (each `{ key, status, score, findings[], raw }`), `headline`, `shareId`, `generatedAt`, `cost` (per section, in units of the provider's call count). Rules: member-read, server-only write.
- `prospectReportShares/{shareId}` → `{ reportId, subAccountId, agencyId, revokedAt }`. Public read is by the server route only, never by client SDK. Mirrors `snapshots` share pattern in `src/lib/snapshots/share.ts`.
- `subAccounts/{id}` — `prospectingEnabledByAgency`, `prospectingReportQuota` (monthly, default 50), `usage/{YYYY-MM}.prospectReports` on the existing usage meter (`src/lib/server/usage-meter.ts`).
- `subAccounts/{id}/private/apexgeoConnection` — API key, base URL, brand id cache. Locked like `googleConnection`.

### Server

- `src/lib/prospecting/` — `sections/*.ts` one module per section with the signature `run(input): Promise<SectionResult>` and a pure `score(raw)` beside it; `severity.ts` (headline ranking); `report-runner.ts` (fan-out, per-section timeouts, partial success); `share.ts`; `quota.ts`; `apexgeo-client.ts`; `approach-guard.ts`.
- Routes under `src/app/api/sub-accounts/[id]/prospecting/`: `lists`, `reports` (POST = enqueue, quota checked here), `reports/[reportId]`, `reports/[reportId]/share` (POST mint, DELETE revoke), `mystery-shop` (POST, requires `confirm: true` and its own 403 while the comms channel is not connected).
- QStash callback `api/automations/prospecting/report` — one report per message, idempotent on reportId, section failures recorded, never retried into a second charge. Use `publishCallback` from `src/lib/automations/qstash.ts`.
- Public: `src/app/r/[shareId]/page.tsx` (server component, no client Firestore) and `api/public/prospecting/report/[shareId]` for the JSON the page renders.
- Get Leads: flip `GET_LEADS_PARKED`, follow the un-park checklist in [get-leads.md](../features/get-leads.md), add "Save as list" to the results bar, and make import write the `prospecting` map.
- Public API: `POST /api/v1/contacts` already exists; add the `prospecting` map to the contacts serializer so ApexSignal can push it. No new v1 route.
- Workflows: no engine change. A `prospecting.report.ready` trigger is added to the catalog and fired by the runner, and `{{prospecting.headline}}` / `{{prospecting.reportUrl}}` merge tags are added in `src/lib/messaging/merge-tags.ts`.

### Approach guard (ported from ApexSignal `send_batch.py`)

Runs inside the contacts service on every outbound step that targets a contact with `source: "prospecting"`: refuse when `prospecting.approachedAt` is set and the campaign tag differs, stamp `approachedAt` before the send is enqueued, never after. Daily cap per sub-account on first-touch sends (`prospectingDailyFirstTouchCap`, default 20). Suppression list is the existing opt-out mechanism; nothing new.

### Agency UI

Manage dialog: gate checkbox, quota number field. Sidebar entry "Prospecting" at `/sa/[id]/prospecting`, `max-w-5xl`, states: locked, empty, list. Contact profile gains a "Reports" card with Generate / View / Share / Revoke and the Mystery-shop button behind a confirm dialog that names the number that will be contacted.

## Dependencies outside this repo

- **ApexGEO**: `POST /api/v1/brands` (name, url) does not exist; audits need a `brand_id`. Add it, or accept `url` without a brand on `POST /api/v1/audits`. One PR in ApexGEO, before PR 3 below. Also confirm that a v1 key with `mcp:read` scope can read `brands/[id]/share-of-voice` and `audits/[id]/decomposition` for a brand it created.
- **ApexSignal**: a `push_leadstack.py` replacing `push_ghl.py`; reads the CSV, POSTs to `/api/v1/contacts` on #1000 with the `prospecting` map, idempotent on phone. Runs from the same cron after the source cycle. The six "interested" replies from 2026-09-08 go first, tagged `warm-reply`, and become tasks for Hein.

## PR sequence (each one independently mergeable, each with a blind `/review`)

| PR | Scope | Gate to merge |
|---|---|---|
| 1 | Gate + quota + schema + rules + Manage dialog + `FEATURE_GATES` entry + un-park Get Leads with saved lists and the `prospecting` map on import and on v1 contacts | tests for the gate 403s, rules tests, tenancy check; Level-3 boundary |
| 2 | `prospectReports` runner with sections 1, 2, 3, 4, 6, 9, 10 (no external key beyond Outscraper/Firecrawl), QStash callback, quota enforcement, share page `/r/[shareId]` | fixture-driven section tests: each `score()` mutation-tested; runner partial-failure test; share id non-enumeration test; browser screenshot of a real report on #1000 |
| 3 | ApexGEO connection + sections 5, 7, 8; "Not connected" state | recorded-response tests against the ApexGEO OpenAPI shapes; live proof on #1000 with a real key |
| 4 | Workflow trigger + merge tags + approach guard + daily cap | seam tests: a workflow enrolled on `prospecting.report.ready` receives the headline; guard refuses a second campaign; cap refuses the 21st send |
| 5 | Mystery-shop actions (form/call, WhatsApp) with confirm dialog | **human gate**: sends reach a real business; first live run is to a number Hein owns |
| 6 | ApexSignal `push_leadstack.py` + cron; warm replies imported | proof: contacts visible in #1000 with tags; Hein's tasks created |

Deploys: after 17:00 SAST, Hein's approval per deploy. `firebase deploy --only firestore:rules,firestore:indexes` after PR 1 (new collections) and again if PR 2 adds a composite index for `prospectReports` by `subAccountId + status`.

## What proves it worked

- A report for a real Gqeberha plumber renders at `/r/{id}` with agency branding and at least 9 of 12 sections populated, screenshot in the PR.
- A workflow on #1000 sends a WhatsApp template whose first line is the report headline, to Hein's own number, with the share link resolving.
- The approach guard refuses a second campaign for the same contact and the daily cap refuses the 21st first-touch send, both shown by tests that go red when the guard line is deleted.
- ApexSignal's cron pushes new rows into #1000 without duplicates over three consecutive cycles.

## Risks carried into the build

- ApexGEO's v1 API is now a contract for outside buyers. Pin `x-api-version`, record the OpenAPI shapes as fixtures, fail the section rather than the report on drift.
- Outscraper field pricing: keep `reviews_limit` ≤ 10 and never request enrichment twice for the same place id (cache on the contact).
- Mystery shop is outbound to real people; PR 5 stays behind the human gate regardless of CI.
- Report generation time: 12 sections with network calls will exceed a request. The runner is QStash-only; the UI polls the report doc.
