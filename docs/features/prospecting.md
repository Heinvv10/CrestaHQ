# Prospecting

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md). Plan and PR sequence: [docs/programme/prospecting-module.md](../programme/prospecting-module.md) (plan, PR #244).*

Status: **PR 3 of 6** — gate, quota, collections, saved lists (PR 1), audit reports with share links (PR 2) and the ApexGEO sections 5/7/8 (PR 3). No message is sent yet.

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

## ApexGEO sections (PR 3)

Sections 5 (website performance), 7 (AI-agent readiness) and 8 (AI answer-engine presence) come from **one brand-less ApexGEO scan per report**, over ApexGEO's v1 API with the sub-account's own key (`lib/prospecting/apexgeo-client.ts`; responses zod-validated — a shape that does not match is `failed`, never a partial fill).

**Connecting.** Settings → Admin → *ApexGEO* card (`components/settings/sub-account-apexgeo-section.tsx`). Every member sees the status; owners/admins paste the key, **Test** it (`POST /api/sub-accounts/[id]/apexgeo-connection/test` → `GET /api/v1/scans?limit=1`, no credits spent; proves the key and its `read` scope — `write` cannot be probed for free), **Save** (`PUT …/apexgeo-connection`, which checks again before storing) and **Remove** (`DELETE`, through an AlertDialog). Not gated on Prospecting. The key lives only in `subAccounts/{id}/private/apexgeoConnection` `{ apiKey, baseUrl }` (the `apexgeo` kind in `SUB_ACCOUNT_SECRETS`; locked by the generic `private/` rule); the sub-account doc carries `apexgeoConnected`, `apexgeoKeyLast4`, `apexgeoBaseUrl`. No response ever carries the key. The default base URL is `https://apexgeo.app`; a custom one must be plain `https://` on the default port, and every call goes through `publicFetch` (public addresses only, no redirects).

**Two phases (D1) — the report never waits for ApexGEO.** A scan takes ~47 s; a report worker has 100 s.
- *Phase 1*, in the report worker: with a key, once the report's own sections make it `ready`, `POST /api/v1/scans` starts with `external_ref = leadstack:report:<reportId>` (a retry replays; nothing is charged twice). A report that fails never starts a scan, so it spends no ApexGEO credits and probe `{ engines: ["gemini", "chatgpt"], prompts: 3 }` (D4 — Perplexity answered `insufficient_quota` on every prompt in ApexGEO's live proof). Niche = `prospecting.category`, city = the contact's `city`, country = its `countryCode` or `ZA`. No website, category or city → the scan is not started and the sections say which field is missing (never a guessed niche). The report is written `ready` as before, with the three sections `pending` and `apexgeo: { scanId, status: "pending", attempts: 0, startedAt }`; then the first poll is queued (45 s). A poll that cannot be queued settles the sections `failed` at once.
- *Phase 2*, `POST /api/automations/prospecting/apexgeo` (QStash, signature bound to the route, public path): `GET /api/v1/scans/{id}`. Completed → the sections are filled, the headline recomputed, `apexgeo.status = "done"`, `cost.apexgeoCredits` recorded. Queued/running → the next poll is queued (45, 90, 180, 240 s — about 10 minutes in all) under a per-attempt dedup id, then `attempts` advances; the last one settles `timeout`. A transient ApexGEO error (network, 429, 5xx) is polled again like a running scan. A failed scan or any other ApexGEO error → `failed` with a generic reason; the real one is only logged. Every poll re-checks the gate (off → stopped) and the key (removed → "disconnected"). Every settle is a transaction that lands only on a report still `ready` whose scan is `pending` at that attempt, so replays and duplicate deliveries are no-ops and concurrent deliveries fill once. A scan still `pending` 30 minutes after it started is shown as timed out.
- The ApexGEO sections never decide `ready` and are never in `STORED_FACT_SECTIONS`. The LeadStack quota is charged once, as before; ApexGEO credits are the agency's own. Out of credits → "ApexGEO account is out of credits", report still `ready`.

**Scoring (D5).**

| Section | Measures | Findings |
|---|---|---|
| website_performance | PageSpeed (mobile) via ApexGEO: LCP ≤ 2.5 s → 100, ≤ 4 s → 70, else 30; −20 without a mobile viewport. A Core Web Vitals error = not measured (unavailable), never slow. | `slow_mobile` (LCP > 4 s). `no_https` stays in business_details. |
| ai_readiness | robots.txt rules for GPTBot, ClaudeBot, PerplexityBot, Google-Extended (Bingbot is not an AI crawler); LocalBusiness schema. 100 −60 −30. An unreadable robots rule is not measured, never blocked. | `ai_crawlers_blocked` (ranked just under `slow_mobile`: a blocked crawler removes the business from those answers), `no_local_business_schema` (ranked beside `listing_missing`: it weakens, it does not remove). |
| ai_presence | Share of voice = answers naming the business / measured answers. An engine answer with `error` is **not measured** — never "not mentioned". Top 3 competitors named (counted once per answer). No engine answered → unavailable. | `not_in_ai_answers` only when every measured engine answered every prompt and none named the business. |

**Public page (D6).** Sections left out because of the agency's own setup — no key (`not_connected`) or its ApexGEO account out of credits (`out_of_credits`) — are **hidden on `/report/[token]`**: a prospect should not see those gaps. The member view shows them, with a *Connect ApexGEO* link for `not_connected`. Pending, timed-out, failed and missing-input sections show honestly on both. The public whitelist shows counts, the models asked and competitor names (public business names) — never the answers' text, `cited_url` or a provider error.

## Not yet

Workflow trigger and merge tags, approach guard, mystery shop, ApexSignal push — each its own PR in the plan. `POST /api/v1/contacts` ignores a `prospecting` field (like any unknown top-level field) and `POST /api/v1/contacts/upsert` refuses it with a 400 — ApexSignal's push (PR 6) either PATCHes after create or extends one of them.
