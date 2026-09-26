# Prospecting

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md). Plan and PR sequence: [docs/programme/prospecting-module.md](../programme/prospecting-module.md) (plan, PR #244).*

Status: **PR 2 of 6** — gate, quota, collections, saved lists (PR 1) and audit reports with share links (PR 2). No message is sent yet.

## What exists

- **Gate** `prospectingEnabledByAgency` (off by default, in `PLAN_GATE_KEYS`, hide-override `prospectingHiddenWhenDisabled`) and the monthly `prospectingReportQuota` (0–1000, default 50 via `lib/prospecting/quota.ts`), both set in the agency Manage dialog. See [feature-gates.md](../architecture/feature-gates.md).
- **Saved lists** — Get Leads' results bar "Save as list" creates a `prospectLists` doc; imports from that result set stamp `contacts.prospecting.listId`. `GET`/`POST /api/sub-accounts/[id]/prospecting/lists`, member auth, 403 `gate_off` while off. Details in [get-leads.md](get-leads.md#save-as-list-prospecting-gate).
- **Page** Sidebar → Prospecting (`/sa/[id]/prospecting`): locked / empty / list states, driven by the GET route.
- **Contacts carry the prospect** — `source: "prospecting"`, tags `["prospecting", <batch>]`, and `contacts.prospecting` `{ listId?, placeId?, website?, rating?, reviewsCount?, category?, approachedAt: null, lastReportId: null }`. The public API returns it (`prospecting`, snake_case, null when absent) and `PATCH /api/v1/contacts/:id` merges it field by field (Prospecting gate, own-sub-account `list_id`; `approached_at` / `last_report_id` read-only — see [public-api.md](public-api.md#contacts-the-prospecting-map)).
- **Collections** `prospectLists`, `prospectReports` (the report worker is the only writer), `prospectReportShares` (no client access). See [firestore-collections.md](../architecture/firestore-collections.md).

## Reports (PR 2)

**Flow.** Contact profile → *Prospect reports* card (rendered only while the gate is on) → Generate → `POST /api/sub-accounts/[id]/prospecting/reports` reserves one report against the month's quota **transactionally** (counter increment + `queued` doc in one transaction; 429 `quota_exhausted` at the cap; 409 `report_in_progress` while that contact already has a queued/running report) and queues it on QStash. The worker (`/api/automations/prospecting/report`) claims it `queued → running`, runs `lib/prospecting/report-runner.ts` (homepage fetched once, sections in parallel, 20 s per section, 100 s per report), and settles `ready` or `failed`. `ready` needs an `ok` from a section that measured something this run — business_details and reputation only restate facts stored on the contact, so they never make a report ready on their own. Homepage and directory fetches take a slot in the reports' own process-wide pool (4 in flight, `lib/prospecting/fetch-slots.ts`), separate from Get Leads enrichment's, so hung report fetches cannot starve a tenant's search. A report whose gate went off after queueing is not run. A report that produces nothing (queue unavailable, runner failed) has its quota **released**. The card polls every 4 s while a report is queued/running. *View* opens the member page `/sa/[id]/prospecting/reports/[reportId]`; *Share* mints a link shown once; *Revoke* 404s it.

**Sections run** (`lib/prospecting/sections/*`; `unavailable` = cannot be measured honestly, never a guessed negative):

| Section | Measures |
|---|---|
| business_details | Name / phone / address / website / category completeness; `no_website`, `no_https` (from the homepage's final URL). |
| gbp | One Places Details call (place id must match `^[A-Za-z0-9_-]{1,300}$`, else unavailable): opening hours, photos, phone. Field mask omits `editorialSummary` (Enterprise + Atmosphere SKU), so the **description is not measured**; `gbp_unclaimed` is never emitted (Places cannot tell). |
| reputation | Places rating + review count already on the contact. Review velocity and owner reply rate are reported **not measured**. |
| listings | Name + phone match on Facebook (the page the website links to), Bing, Yellow Pages SA, Brabys, Cylex. |
| tech_stack | Homepage fingerprints (`tech-rules.ts`, original rules — not Wappalyzer's GPL text); `no_analytics`. |
| ads | Always `unavailable`, with manual-check links. |
| lead_capture | WhatsApp click-to-chat, booking, contact form, tap-to-call, live chat on the homepage. |

**Decisions.**
- **D1** — the public URL is `/report/[token]` (not `/r/`, which is the review page). Token is hashed at rest; every refusal is the same 404 — including the sub-account's gate being off or the contact being gone; `noindex`, `no-referrer`. The business name — and the Meta Ad Library link, which searches by it — is published only when the contact has a company or is a prospecting import (otherwise it may be a person's name). The member view gets the same whitelisted sections; `raw` never leaves the server. Only the keys named in `lib/prospecting/public-sections.ts` reach the public page — `raw` is never passed through.
- **D2** — reputation is the Places rating + count only. Revisit trigger: the first buyer who asks for review velocity.
- **D3** — one homepage fetch per report, shared by every section.
- **D5 outcome** — ads cannot be measured keylessly: Meta Ad Library answers 403; Google Ads Transparency is a JS shell over an undocumented RPC. The section links to both for a manual check; `no_ads_running` is never emitted.
- **Listings outcome** — Brabys and Cylex answer 403 (Cloudflare); Yellow Pages SA is a client-rendered shell → `unknown`. Bing and the Facebook page linked from the website are checked. `listing_missing` is never emitted: no directory gives a miss we can trust.

**Interrupted and stale reports.** A worker killed mid-run (a blue/green cut-over drains for 60 s, less than the 100 s deadline) leaves its report `running`. A delivery that finds it `running` inside the deadline + 60 s answers 503, so QStash keeps retrying (default schedule: ~12 s, ~2.5 min, ~30 min); the first delivery past that window settles it `failed` (`failureReason: "interrupted"`, quota released). The worker's final `ready` write only lands on a report still `running`, so one settled meanwhile keeps its state. Independently, the list route settles any queued/running report older than 10 minutes (`failureReason: "stale"`, quota released) before answering, so a polling card always settles. Both checks re-read the report's age inside the release transaction.

## Not yet

ApexGEO sections, workflow trigger and merge tags, approach guard, mystery shop, ApexSignal push — each its own PR in the plan. `POST /api/v1/contacts` ignores a `prospecting` field (like any unknown top-level field) and `POST /api/v1/contacts/upsert` refuses it with a 400 — ApexSignal's push (PR 6) either PATCHes after create or extends one of them.
