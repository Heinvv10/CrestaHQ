# Prospecting module — plan

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Status: PR 1 merged and live (2026-09-24, #245 + #247); PR 2 built (#288, 2026-09-26); PR 3 live (#302); PR 4 built (2026-09-27, not merged); PR 6 live (ApexSignal); PR 5 not started. Grilled with Hein on 2026-09-24; the rulings under "Settled" are closed and are not to be re-opened by an implementer.*

**REVISED 2026-10-12** — the status line above is out of date: PRs 1–6 are all live. PR 4 merged as #316 (`d6aa4473`) and PR 5 is live at `ff157593` (see "PR 5 live"). PR 6 lives in the ApexSignal repo, so this repo has no merge SHA for it.

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

Outscraper dropped 2026-09-24 — Hein ruled out paying per search; Get Leads (the sourcing door for this module) runs on Google Places API (New) instead. See "Report sections" and [get-leads.md](../features/get-leads.md) for the live shape.

## Report sections

| # | Section | Source | Cost owner | GHL has it |
|---|---|---|---|---|
| 1 | Business details (name, phone, address, hours, categories, website) | Google Places row already returned by Get Leads | agency Google Places key (free tier) | yes |
| 2 | Google Business Profile completeness (claimed, photos, hours, description, posts, Q&A) | Places Details for the place id (name, hours, category already in the Text Search row; photos/hours/description may need a Places Details call on the Pro/Enterprise SKU — within the free tier at these volumes) | Google Places key | yes |
| 3 | Reputation (rating, review count, velocity last 90 d, owner reply rate) | rating + review count from Places (Text Search row); a reviews sample needs the Atmosphere SKU — velocity/owner-reply-rate needs Places reviews (Enterprise+Atmosphere SKU) — decide in PR 2 | Google Places key | yes |
| 4 | Listings / NAP consistency (Facebook page, Bing Places, Yellow Pages SA, Brabys, Cylex) | own HTTP checks, name+phone match, no paid citation API | none | yes |
| 5 | Website performance (Core Web Vitals mobile, HTTPS, mobile viewport) | ApexGEO audit (PageSpeed inside it) | ApexGEO key | yes |
| 6 | Tech stack (CMS, builder, analytics, chat widget, booking widget) | own fingerprinting from the fetched HTML using the open-source Wappalyzer rule set, top ~40 rules only | none | yes |
| 7 | **AI-agent readiness**: LocalBusiness schema, meta, robots.txt allow/deny for GPTBot, ClaudeBot, PerplexityBot, Google-Extended | ApexGEO audit decomposition | ApexGEO key | no |
| 8 | **AI answer-engine presence**: is the business named for "best {niche} in {city}" across Google AI Overview + ChatGPT + Perplexity + Gemini, with share of voice against the top 3 named competitors | ApexGEO brand mentions / share-of-voice | ApexGEO key | no |
| 9 | **Ads running**: Meta Ad Library + Google Ads Transparency lookups by page/domain | own fetch, public, no key | none | no |
| 10 | **Lead capture on site**: WhatsApp click-to-chat link, booking widget, form, phone tel: link, chat widget | own check on rendered HTML (Firecrawl scrape already in the repo) | Firecrawl key | no |
| 11 | **Speed-to-lead mystery shop** (separate action): submit their contact form or place a call from the sub-account's number, time the first response; rand value of a missed lead from an editable per-niche job value (REVISED 2026-10-12 — see PR 5 live) | LeadStack's own comms rails | Twilio/Vapi | no |
| 12 | **WhatsApp responsiveness** (separate action): message the listed number from the sub-account's WhatsApp sender, time the reply | WhatsApp Cloud sender | Meta | no |

Headline of the report = the single worst finding, ranked by a fixed severity table (no site > no HTTPS > not in any AI answer > no GBP claim > slow mobile > no WhatsApp CTA > …). That sentence is what the outreach merge tag uses.

Report page: `/report/{token}` (see D1 below), public, non-enumerating id, branded from agency Company Settings exactly like the GHL share links (logo, colours, agency name, CTA to the agency's booking page). PDF export is now scoped in the [prospect report redesign SOW](prospect-report-redesign-sow.md) (R5).

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
- Public: `src/app/report/[shareId]/page.tsx` (server component, no client Firestore) and `api/public/prospecting/report/[shareId]` for the JSON the page renders.
- Get Leads: flip `GET_LEADS_PARKED`, follow the un-park checklist in [get-leads.md](../features/get-leads.md), add "Save as list" to the results bar, and make import write the `prospecting` map.
- Public API: `POST /api/v1/contacts` already exists; add the `prospecting` map to the contacts serializer so ApexSignal can push it. No new v1 route.
- Workflows: one engine seam, the approach guard in `runStep` (see "PR 4 decisions"). A `prospecting.report.ready` trigger is added to the catalog and fired by the runner, and `{{prospecting.headline}}` / `{{prospecting.reportUrl}}` merge tags are added in `src/lib/messaging/merge-tags.ts`.

### Approach guard (ported from ApexSignal `send_batch.py`)

Runs inside the contacts service on every outbound step that targets a contact with `source: "prospecting"`: refuse when `prospecting.approachedAt` is set and the campaign tag differs, stamp `approachedAt` before the send is enqueued, never after. Daily cap per sub-account on first-touch sends (`prospectingDailyFirstTouchCap`, default 20). Suppression list is the existing opt-out mechanism; nothing new.

### Agency UI

Manage dialog: gate checkbox, quota number field. Sidebar entry "Prospecting" at `/sa/[id]/prospecting`, `max-w-5xl`, states: locked, empty, list. Contact profile gains a "Reports" card with Generate / View / Share / Revoke and the Mystery-shop button behind a confirm dialog that names the number that will be contacted.

## Dependencies outside this repo

- **ApexGEO**: resolved with a brand-less `POST /api/v1/scans` + `GET /api/v1/scans/{id}` (ApexGEO plan PR #880, live-proven 2026-09-25), used by PR 3.
- **ApexSignal**: a `push_leadstack.py` replacing `push_ghl.py`; reads the CSV, POSTs to `/api/v1/contacts` on #1000 with the `prospecting` map, idempotent on phone. Runs from the same cron after the source cycle. The six "interested" replies from 2026-09-08 go first, tagged `warm-reply`, and become tasks for Hein.

## PR 2 decisions (2026-09-26, recorded from the build)

- **D1 — public URL is `/report/[token]`, not `/r/[shareId]`.** `/r/[token]` is already the compliance-sensitive public review page; a sibling dynamic segment at `/r` is a Next.js build error and would put report code beside the review-gating code.
- **D2 — Section 3 uses Places `rating` + `userRatingCount` only.** No Atmosphere/reviews SKU: it is paid per call, shares the 30/day SearchText budget, and Places caps the review sample anyway. Review velocity and owner-reply rate are shown as "not measured", never faked. **Public exception (R0, C6 in the [redesign SOW](prospect-report-redesign-sow.md)):** the public page leaves unmeasured rows out rather than labelling them; the member view still shows "not measured". **Revisit when** the first buyer asks for review velocity.
- **D5 — Section 9 (ads) ships `unavailable`.** Spike: Meta Ad Library answers a keyless GET with 403; Google Ads Transparency Center is a 2.5 MB client-rendered shell backed by an undocumented internal RPC. The section returns manual-check links and never a guessed "no ads". Revisit if either publishes a keyless API.
- **Section 4 listings:** Brabys and Cylex are behind Cloudflare 403s and Yellow Pages SA serves a JS shell, so they come back `unknown`. Bing (server-rendered, noisy) and the Facebook page linked from the business's own site are checked. `listing_missing` is never emitted, because no directory's "not found" is trustworthy.
- **Section 2 GBP:** one Places Details call, mask `id,businessStatus,photos,regularOpeningHours,nationalPhoneNumber`. `editorialSummary` is an Enterprise+Atmosphere field, so the description is not measured. Places cannot tell "claimed", so `gbp_unclaimed` is not emitted.

## PR 3 decisions (2026-09-27, recorded from the build)

- **D1 — two-phase, asynchronous.** The report never waits for ApexGEO (a scan takes ~47 s; a worker has 100 s). Once the report's own sections make it `ready`, the worker starts one scan (`external_ref = leadstack:report:<id>`, so a retry replays and is not charged), writes the three sections `pending`, and queues a QStash poll (`/api/automations/prospecting/apexgeo`, 45/45/90/180/240 s, about 10 minutes, transient ApexGEO errors polled again). Polling won over ApexGEO's webhook: no new public route or signing-secret storage. A failed report never starts a scan.
- **D4 — probe `{ engines: [gemini, chatgpt], prompts: 3 }`.** Perplexity answered `insufficient_quota` on every prompt in ApexGEO's live proof. Niche = `prospecting.category`; town and country from the Google listing when it names a town, else the contact's `city` / `countryCode`, country defaulting to `ZA` (see the city gap below). With no website, category or city the scan is not started and the sections say which is missing; a niche or city is never guessed.
- **D6 — the agency's own setup gaps are hidden from the prospect.** On `/report/[token]`, sections not measured because there is no ApexGEO key, or its account is out of credits, are left out. The member view shows them (with a *Connect ApexGEO* link). Pending, timed-out, failed and missing-input sections show on both, and the reasons a prospect can see never name the vendor (white-label).
- **Gap found in the live proof — prospects had no city. Resolved (Hein, 2026-09-27: option a).** On #1000, 0 of 648 prospects with a website carried `city` (ApexSignal pushes `address: "ZA"`; Places rows rarely give one), but all 648 have a place id. The GBP section's Places Details call now also requests `addressComponents` (an Essentials field, no higher SKU); the scan takes the town from the listing (`locality`, else `postal_town`) when it names one, with the listing's country (else the contact's), otherwise the contact's city and country — listing first, because a form contact's city is an IP guess (review of #308). A listing with neither still gives "not measured", never a guess.

## PR 4 decisions (2026-09-27, recorded from the build)

These replace the "Approach guard" section above where they differ (it named the contacts service and a campaign tag).

- **Prospect** = `contact.source === "prospecting"` or a `prospecting` map present.
- **Campaign key = workflow id.** The guard stamps `prospecting.approachedAt` and `prospecting.approachedWorkflowId`; a send from any other workflow is refused. The same workflow's later sends pass and are not counted again; each takes the stamp over (`prospecting.approachedRunId` / `approachedNodeId`, added by the J1 port), so only the send that holds it can hand it back. A prospect stamped before this PR with no workflow id is refused by every workflow.
- **First touch** = a guarded send that found `approachedAt` unset; only first touches count toward `prospectingDailyFirstTouchCap` (Manage dialog, 0–1000, default 20).
- **Stamp before the send**, in the same transaction that takes one from `subAccounts/{id}/prospectingFirstTouch/{YYYY-MM-DD}` (day in the send-window timezone, else Africa/Johannesburg; server-only, default-deny rules). A stamped step that then fails for another reason (e.g. WhatsApp not configured) keeps its stamp and count.
- **Seam:** `runStep` in `lib/workflows/engine.ts`, after the at-most-once claim, before the executor, for `send_email`, `send_sms`, `send_whatsapp`, `whatsapp_template`. The channel opt-out / missing-address skip runs first (`channelOptedOut`, now shared with the executors), so an opted-out prospect is never stamped or counted.
- **Refusal `already_approached`:** the run ends (completed), history `skipped:approach_guard:already_approached`, an `automation_step_skipped` row on the contact.
- **Refusal `daily_cap`:** the step is held to 08:00 local **the next day** through the quiet-hours defer path. That path writes no history entry (an entry marks the step done), so `deferred:approach_cap` is the log string and the contact timeline row says the cap is reached.
- **Guard infra error fails closed:** it throws, the claim is released, QStash retries; nothing is sent.
- **Not guarded:** manual conversation sends, AI capability sends, broadcasts.
- **Trigger `prospecting.report.ready`** (final-announce protocol, prospect report redesign C1 — [SOW](prospect-report-redesign-sow.md#announce-protocol-c1)): the worker's `queued → running` claim stamps `announceProtocol: 1`. The `ready` write mints the share (creator = the report's requester) and stamps `prospecting.lastReportId` / `lastReportUrl` on the contact in one transaction, so the link is stable from ready. The headline and the trigger wait for the report to be **final**: every final-settle transaction (the poll's done/failed/timeout/stopped, the worker's settle when no poll could be queued, ready with no scan, the sweep) writes `announceDueAt`, then `announceReport` stamps `lastReportHeadline` from the final report and fires `{ reportId }` with `enrolmentKey: "report:<id>"`, then writes `announcedAt` (`announceReason: "fired"`). A report that is no longer the contact's `lastReportId` is recorded `"superseded"`, and one without a live share or `lastReportUrl` `"no live link"`; neither fires. A member re-mint re-stamps, and a revoke clears, `lastReportUrl` inside the share transaction when the report is the contact's latest. Recovery: the poll's no-longer-pending path and a 15-minute QStash sweep (`/api/automations/prospecting/announce-sweep`, which also settles as a timeout an R0-era scan pending 30 minutes) announce anything due. A re-fire is harmless: the engine refuses a second run for the same `workflowEnrolmentKeys` doc under every re-entry policy. Reports claimed before this protocol carry no `announceProtocol` and are never announced again. A failed report fires nothing; a firing error leaves `announcedAt` unset for the next pass. Zero enrolments is final, recorded as `announceReason: "not enrolled"` with `announceSkips`, including `automations_paused` (the sub-account's stop switch; other triggers drop their events while paused too) and `no_active_workflow` (the normal state for a sub-account that does not use this trigger).
- **Merge tags** `{{prospecting.headline}}` / `{{prospecting.reportUrl}}` read the contact's `lastReportHeadline` / `lastReportUrl` in both renderers (workflow sends and the composer, which lists them in its picker).

## PR sequence (each one independently mergeable, each with a blind `/review`)

| PR | Scope | Gate to merge |
|---|---|---|
| 1 | **DONE (#245, #247)** — Gate + quota + schema + rules + Manage dialog + `FEATURE_GATES` entry + un-park Get Leads with saved lists and the `prospecting` map on import and on v1 contacts | tests for the gate 403s, rules tests, tenancy check; Level-3 boundary |
| 2 | **DONE (#288)** — `prospectReports` runner with sections 1, 2, 3, 4, 6, 9, 10 (no external key beyond Google Places/Firecrawl), QStash callback, quota enforcement, share page `/report/[token]` | fixture-driven section tests: each `score()` mutation-tested; runner partial-failure test; share id non-enumeration test; browser screenshot of a real report on #1000 |
| 3 | **DONE (#302)** — ApexGEO connection + sections 5, 7, 8; "Not connected" state; deployed 7f7b4882, proven on #1000 2026-09-27 ([evidence](../parity/evidence/prospecting-pr3/README.md)) | recorded-response tests against the ApexGEO OpenAPI shapes; live proof on #1000 with a real key |
| 4 | **LIVE** (built 2026-09-27; merged as #316, `d6aa4473`) — Workflow trigger + merge tags + approach guard + daily cap ([mutations](../parity/evidence/prospecting-pr4/mutations.md)) | seam tests: a workflow enrolled on `prospecting.report.ready` receives the headline; guard refuses a second campaign; cap refuses the 21st send |
| 5 | **LIVE (2026-10-12)** — Mystery-shop actions (form/call, WhatsApp) with confirm dialog. **5a BUILT (2026-10-08)**: shared model (`mysteryShops`), email + AI call, 24 h QStash timer, section 11/12 rendering, card + dialog, settings card. **5b BUILT (2026-10-09)**: WhatsApp via an approved Cloud template, reply + receipt matching on the Cloud webhook, template status in settings. **5c BUILT (2026-10-09)**: contact form. **LIVE 2026-10-12** (5a/5b/5c at `ff157593`; follow-up SHAs under "PR 5 live" below) | **human gate**: sends reach a real business; first live run is to a number Hein owns |
| 6 | ApexSignal `push_leadstack.py` + cron; warm replies imported | proof: contacts visible in #1000 with tags; Hein's tasks created |

Deploys: after 17:00 SAST, Hein's approval per deploy. `firebase deploy --only firestore:rules,firestore:indexes` after PR 1 (new collections) and again if PR 2 adds a composite index for `prospectReports` by `subAccountId + status`.

**REVISED 2026-10-08 (PR 5a)** — decisions taken while building the mystery shop:

- A mystery shop does not stamp `approachedAt` and is not a workflow step; the approach guard is unchanged. An open shop does **not** block outreach workflows to the same contact.
- The email channel needs the IMAP mailbox connected as well as a verified SMTP sender: without mailbox sync no reply can be seen, and every shop would read as a missed lead on a public report.
- Call targets are the contact's own phone only. The lead-capture section stores booleans (`phoneLink`), not numbers, so it adds no targets.
- A call is "answered" only after a real exchange: the callee speaks after our opening, then we reply, then the callee speaks again — after the last callee turn that sounds like a voicemail greeting or phone menu ("leave your name and number", "press 1 for …", Afrikaans "los 'n boodskap" — not "you've reached", which people say when they answer), whatever Vapi's endedReason. A single callee turn is ambiguous, so it is not answered: the shop goes missed for a member to check. A miss is public only after a member confirms it (round 3). Vapi gives no answer timestamp: the response time is the report's `startedAt` (else `endedAt − duration`) minus the send.
- SMS callbacks are not matched: Twilio is not configured on any sub-account.
- The cap is `prospectingMysteryShopCap` (default 10 a month) on the usage ledger beside the report quota; a refused or failed send gives its slot back.

**REVISED 2026-10-09 (PR 5b)** — WhatsApp:

- It sends only from a **Cloud** default sender, and only an approved template with exactly two variables (`{{1}}` service, `{{2}}` town): replies are timed on the Cloud inbound webhook. The template is `prospectingMysteryShopTemplates.whatsappTemplateId`, else the one named `leadstack_speed_check`. A refusal names the template's Cloud status (pending / rejected: reason / approved on another account only / wrong variables).
- With no town, `{{2}}` is "your area": sub-accounts have no town field of their own to fall back to.
- A reply counts from the target number only, at Meta's own message timestamp, with `senderAuth: "pass"` (the number is WhatsApp's registration on Meta's signed webhook). WhatsApp Business away / greeting texts (en, af) are `autoReplyAt` only. A STOP / START word from the number is an opt-out, not a response.
- A Cloud `failed` receipt for our message id makes the shop `failed` / `undeliverable` (slot kept, never public); `delivered` / `read` are stamped for the card.
- Bridge and Twilio inbound are not matched: #1000 is Cloud. Cloud template sends are not metered (no template send on that rail is).
- Review round 1: a reply within 60 s of the send, or a short message that is mostly greeting/away phrasing, is automatic; reactions and system notices don't count. Our WhatsApp AI never answers a number (or contact) with a WhatsApp shop inside the late-reply horizon (one guard in `maybeRespondWithAi`, all rails), and the send pauses the bot until then. A WhatsApp miss can be confirmed only with a delivery receipt, never after a STOP, and after an automatic-looking reply only once the member says they read the thread. One open WhatsApp shop per number.
- Review round 2: the first minute runs from delivery (a greeting fires on delivery; before any receipt a reply is automatic); replies are matched even after Prospecting is switched off; a miss whose thread holds an inbound message from the target since the send needs the member to read it before confirming; a read receipt is delivery evidence; a STOP withdraws a confirmation.

**REVISED 2026-10-09 (PR 5c)** — the website-form channel:

- Lead capture gained `formUrl` (member-only, never in `PUBLIC_RAW_KEYS`), because it stored no URL: the homepage's final URL when it has the form, else the first same-site contact-looking link. No extra page is fetched for the report. Reports from before it have no `formUrl`, so the form channel asks for a new report. The only allowed form target is the latest ready report's `formUrl`, compared after WHATWG normalisation.
- The engine is headless Chromium from `playwright-core` (pinned to `@playwright/test`'s version, sharing its browser cache), run as a QStash job with one job per box (a Firestore lease). Chromium never opens a connection itself: every request is fetched in Node through `publicFetch` and fulfilled, with a dead proxy as the backstop. Redirects are followed hop by hop through the same guard, because a fulfilled 3xx would be followed by Chromium's own network stack.
- It refuses on any CAPTCHA or bot challenge before typing, and never bypasses one. It also refuses login forms, required uploads, multi-step forms, required consent boxes, honeypots it would have to fill, values the form truncates or would not validate, and required fields it cannot fill truthfully. It fills the sub-account's name, its synced mailbox address and its Cloud WhatsApp number (else Branding's). A confirmation signal counts only once a request carrying the enquiry was answered; a 2xx that says the site refused it is `failed` / `form_rejected` (slot kept, never public). A submit with no confirmation signal is an uncertain send, never a refund.
- The reply is matched by email, from the form site's domain or the contact's own address, and by a WhatsApp reply from one of the contact's own numbers (through PR 5b's matcher and its automatic-reply rules). A phone call to the number typed into the form is NOT tracked (it is the WhatsApp number, not the AI-call line); the card tells the member to check their phone before confirming a miss.
- The fill runs in a disposable, locked-down Docker container per job (no secrets, no volumes, read-only root, all capabilities dropped, 1 GB, killed at 60 s); the CRM keeps the lease, the claim and the settle, and trusts nothing the container says unless it validates. Chromium's own sandbox cannot start in the container on velo (AppArmor restricts unprivileged user namespaces), so the container is the isolation. The deploy builds the image (`scripts/form-engine-image.mjs`; see RUNBOOK.md).

**REVISED 2026-10-12 (PR 5 live)** — sections 11 and 12 are deployed and walked on #1000:

- Deploys, all on `crm.crestahq.com` (crestahq@4302 behind the proxy on :4300): 5a/5b/5c at `ff157593`; #368 (an email reply to a different thread of ours is ignored) at `df016c3f`; #370 (the form engine's town role) at `d2639603`; #373 (QStash legacy signing keys) at `4dfb5a8a`, the current prod head.
- Live walks, to targets the owner controls, all 2026-10-12:
  - **Email, responded:** the reply was matched and the shop settled `responded` with its response time.
  - **Email, missed:** after the 24 h timer the shop went `missed`; a member confirmed it; the public report then read "No response within 24 h — an estimated R1,500 lead missed" (the rand figure comes from the editable per-niche job value). The target never appears on the public page.
  - **WhatsApp:** a reply inside 60 s was classed `autoReply` and the card raised the review flag, rather than counting as a human response (the round 1 rule).
  - **Website form:** refused on crestahq.com because the form has no message field. This is deliberate: the engine will not submit a form it cannot fill truthfully.
  - **Reply to another of our emails:** proven ignored (#368).
- Test data: every shop created for the walks was deleted; #1000 holds 0 mystery shops.
- **NOT walked:** the AI call. Outbound calling is off on #1000, so the call channel, its answered/voicemail classification and the call-miss path have only fixture-driven test coverage, not a live proof. Treat it as unproven until a call is placed from a sub-account with outbound enabled.
- **REVISED 2026-10-12** — the Report sections table (rows 11 and 12) says section 11 uses "Twilio/Vapi" and "submit their contact form or place a call". As built, the channels are email, AI call (Vapi) and website form; SMS is not matched and Twilio is not used (see the 2026-10-08 note). Section 12 sends only from a Cloud sender with an approved template.

## What proves it worked

- A report for a real Gqeberha plumber renders at `/r/{id}` with agency branding and at least 9 of 12 sections populated, screenshot in the PR.
- A workflow on #1000 sends a WhatsApp template whose first line is the report headline, to Hein's own number, with the share link resolving.
- The approach guard refuses a second campaign for the same contact and the daily cap refuses the 21st first-touch send, both shown by tests that go red when the guard line is deleted.
- ApexSignal's cron pushes new rows into #1000 without duplicates over three consecutive cycles.

## Risks carried into the build

- ApexGEO's v1 API is now a contract for outside buyers. Pin `x-api-version`, record the OpenAPI shapes as fixtures, fail the section rather than the report on drift.
- Google Places daily caps (30 SearchText/day, 100 Geocoding/day) are Google Cloud config, not code, and there is no per-sub-account search limit — one client can spend the deployment's whole daily quota. Cache Places lookups per place id rather than re-fetching for report sections.
- Mystery shop is outbound to real people; PR 5 stays behind the human gate regardless of CI.
- Report generation time: 12 sections with network calls will exceed a request. The runner is QStash-only; the UI polls the report doc.
