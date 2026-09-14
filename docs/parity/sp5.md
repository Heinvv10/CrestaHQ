# SP5 — Reputation & Google Business Profile (remainder)

**Date:** 2026-09-14 · **Status: all SP5 PRs merged 2026-09-14 (#121 #122 #124 #126 #128 #129 #132 #135); deployed to crm.crestahq.com 2026-09-14 17:48 SAST (cde3b17); live Google blocked on case 4-6894000042302** · **Depends on:** SP0 (merged), the GBP reviews stack #77–#81 (merged, deployed 2026-09-11) · **Blocks:** SP11 (review reports), SP14 (GBP per listing).
Programme context: [PARITY_PROGRAM.md](../PARITY_PROGRAM.md) §SP5. Model ledger: [sp1.md](sp1.md). Feature spec: [gbp-reviews.md](../features/gbp-reviews.md).

Proving tenant: **#1000 CrestaHQ** (`subAccounts/54vPI0BS1zDMcxMyMAyA`) and the E2E fixture tenant. Never Blitz/Velocity/Vortex.

Definition of done per row: Playwright spec in `e2e/specs/` (mutation-proven, blocking CI) + blind review APPROVED + shown in the browser with a screenshot under `docs/parity/evidence/sp5/`.

> **Live Google is blocked for the whole GBP API family, not just v4.** Probed 2026-09-14 with #1000's real grant (refresh → 200): `mybusinessaccountmanagement.googleapis.com` and `businessprofileperformance.googleapis.com` both answer **429 RESOURCE_EXHAUSTED, `quota_limit_value: "0"`** for project 893869567850. The Performance API is *enabled* but has no quota until Google approves case **4-6894000042302**, exactly like v4 reviews. So every row that talks to Google — reviews, replies, listing discovery, **and insights (f)** — is proven on the fenced fake provider and marked **blocked: case 4-6894000042302** for its live half. #1000's live Google Business page shows "Couldn't load listings from Google (error)" for the same reason (`evidence/sp5/before/01`), and has no listing selected.

---

## Ledger

Columns: GHL behaviour (observed 2026-09-14 in the CrestaHQ location `jEr9SOZnEyVsi8oK2Vnj`, empty; populated layouts read on the Blitz location — **aggregate charts only** are kept as evidence, no review text or reviewer names; screenshots in `evidence/sp5/ghl/`, sidebars cropped, owner name and sender number redacted) · LeadStack today (code at `bd58674`, browser on #1000 2026-09-14) · Gap · PR · Spec · Status.

### Navigation

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| N1 | Top-level sidebar **Reputation** with tabs Overview · Requests · Reviews · Video Testimonials · Widgets · Listings · GBP Optimization · Settings (`ghl/01`) | No Reputation entry. GBP lives at **AI Agents → Google Business** (`components/ai-agents/channels.ts:145`); review-request settings at Settings → Google reviews | Sidebar **Reputation** → `/sa/[id]/reputation` with tabs Overview · Reviews · Requests · Widgets · Insights · Settings. Reviews/Widgets tabs mount the existing components; the AI Agents → Google Business page stays (connect + listing), linked from Settings | #122 | `reputation-overview.spec.ts` | merged #122 |

### Overview (GHL "My Stats")

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| V1 | **Average rating** + **Total reviews** tiles with period-over-period change (`ghl/11`) | `gbpSummary.averageRating` / `totalReviewCount` on the Google Business page only (`reviews-section.tsx`) | Tiles on Overview; the change compares the chosen range with the range before it, computed from the cached reviews | #122 | `reputation-overview.spec.ts` | merged #122 · live half **blocked: case 4-6894000042302** |
| V2 | **Reviews and ratings trend**: average rating and review count per period (line/area charts, `ghl/11`) | None. Charts exist as hand-rolled SVG in `components/reports/charts.tsx` (no chart library) | Trend from `gbpReviews.createTime` bucketed by month (or week for ranges ≤ 90 days), reusing `AreaChart`/`BarChart` | #122 | same | merged #122 · live half **blocked: case 4-6894000042302** |
| V3 | Date range + Sources filter | — | Date range (presets 30/90/365 days, all time). Sources = Google only today, so no source filter | #122 | same | merged #122 |
| V4 | Star distribution (Reviews page sidebar: 5★ 65% … 1★) | None | Distribution bars on Overview | #122 | same | merged #122 · live half **blocked: case 4-6894000042302** |
| V5 | **Review response**: responded vs unresponded, **response coverage**, **avg response time** + trend (`ghl/13`, `ghl/14`) | Replies are cached (`reply.updateTime`) but never aggregated | Coverage = replied ÷ active reviews in range; **time to latest reply** = `reply.updateTime − createTime` (Google exposes only the latest reply time — an edited reply moves it; the label says so). GHL's "Responded by AI" split: see V7 | #122 | same | merged #122 · live half **blocked: case 4-6894000042302** |
| V6 | **Review request**: volume and conversion across Email, SMS, WhatsApp | Requests leave no queryable record: a `review_requested` activity under each contact (no `subAccountId` on it, so no cross-contact query) + `contact.reviewRequestedAt` | New server-only `subAccounts/{id}/reviewRequests` log written by the dispatcher (`lib/reviews/request.ts`) on every send it makes (Request review, quote paid, deal completed); Overview shows **requests sent vs reviews gained** per period side by side — gained is NOT attributed to a request (Google gives no link between them); the card says counting starts at the first logged request and names the senders the log does not cover yet | #122 #129 | same, `reputation-requests.spec.ts` | merged #122 (dispatcher senders) + #129 (every review-ask sender) |
| V7 | **Sentiment analysis** donut: positive / negative / neutral (`ghl/12`) | None | Donut over reviews in range once (b) lands; empty-state until then | #124 | `reputation-sentiment.spec.ts` | merged #124 · live half **blocked: case 4-6894000042302** |
| V8 | Onboarding checklist (connect GBP, review link, Reviews AI, widget, first request) (`ghl/01`) | None | Checklist card on Overview from real state (connection, listing, `googleReviewConfig.reviewUrl`, widget, any request) — no stored progress | #122 | same | merged #122 |
| V9 | AI Recap / AI summary of reviews | None | **Not building** in SP5 (SP7 owns summaries) | — | — | out of scope |
| V10 | Video testimonials, QR-scan and widget-impression tiles | None | **Not building** (no video testimonials; widget impressions would need tracking pixels on customer sites) | — | — | out of scope |
| V11 | Competitor Analysis tab | None | **Not building** (needs third-party listing data) | — | — | out of scope |

### Reviews

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| R1 | Reviews list: reviewer, stars, date, text, listing name, owner reply under it | **Shipped #78/#81**: newest first, byte-exact comment incl. translated block, reply under it (`reviews-section.tsx`; E2E `gbp-sync.spec.ts`) | — (Reviews tab mounts it) | #78 #81 | `gbp-sync.spec.ts` | parity (fixture) · live **blocked: case 4-6894000042302** |
| R2 | Filters: Ratings, Sources, date range, search | **Shipped #81**: stars, replied/unreplied, from/to, sort (`review-filters.tsx`; `gbp-reply.spec.ts`) | Text search — not building (GHL's is a name search over a list that is already filterable) | #81 | `gbp-reply.spec.ts` | parity (fixture) |
| R3 | **Reply** (manual) posts to Google | **Shipped #81**: explicit human reply, idempotency ledger, no delete button (`reply-composer.tsx`; `gbp-reply.spec.ts`) | — | #81 | `gbp-reply.spec.ts` | parity (fixture) · live **blocked: case 4-6894000042302** |
| R4 | **Sentiment** icon per review (green smiley etc.) | None | `sentiment {label, method, basisHash, model, at}` cached on the `gbpReviews` doc. Star-only reviews: `method:"rating"` (4–5 positive, 3 neutral, 1–2 negative), no AI call. Reviews with text: `method:"ai"` via OpenRouter, batched. Re-sync never re-bills: classify only when `sentiment` is absent or `basisHash ≠ sha256(starRating, comment)` (an edited review); tombstone clears it with the content | #124 | `reputation-sentiment.spec.ts` (asserts the fake AI call count is unchanged after a second sync) | merged #124 · live half **blocked: case 4-6894000042302** · production has no `OPENROUTER_API_KEY` yet → star-only labels only |
| R5 | **AI Reply (Free)** button drafts a reply; **Reviews AI** modes Auto Responses / Suggestive / Off (`ghl/07`) | None ("There is no AI draft in v1", gbp-reviews.md) | **Suggestive only**: "Draft with AI" in the reply composer fills the textarea; the human edits and clicks **Post reply to Google** (the existing route). No auto-response mode and no automatic post from any path | #135 | `reputation-ai-draft.spec.ts` (asserts zero `putReply` calls until the click) | merged #135 · live half **blocked: case 4-6894000042302** · needs `OPENROUTER_API_KEY` in production |
| R6 | Reviews AI **agents** with tone / per-rating targeting; **Drip Mode** auto-replies the backlog at a steady pace (`ghl/07`) | None | Reply guidelines (free text: tone, sign-off, things never to say) in Reputation Settings, used by the draft. **Auto-reply and drip-reply are not built** — replies stay an explicit human click (goal rule) | #135 | same | merged #135 (reply guidelines; auto/drip reply deliberately not built) |
| R7 | Add Reviews manually; Spam Reviews detection (`ghl/10`) | None | **Not building** (manual reviews are unverifiable; Google does its own spam filtering) | — | — | out of scope |

### Requests

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| Q1 | **Requests** list: search by name/email/phone, **Status** filter (Queued, Undelivered, Failed, Sent, Delivered, Opened, Read), **Sent via** filter (Email, Phone, WhatsApp) (`ghl/02`, `ghl/03`) | Dispatcher sends exist (manual Request review from the contact profile; auto on quote paid and deal completed — `lib/reviews/request.ts:93`), but nothing lists them. The Conversations composer's "Ask for review" does not use the dispatcher — it inserts text into a normal message | Requests tab over the `reviewRequests` log (from (a)): contact, channel, trigger, sent at, status. Statuses we can observe truthfully: **sent · failed · clicked** (the `/r/[token]` Google button) **· feedback** (the private feedback form). Delivered/read are not wired to the log — not shown rather than guessed. Filters: status, channel, search. Log every review-ask sender: a review link pasted into a workflow SMS / WhatsApp / email step body, a WhatsApp template's variable or button (e.g. the `review_request` starter), a link pasted into a broadcast email, and the Conversations composer's "Ask for review" (or a typed link) | #129 #132 | `reputation-requests.spec.ts` | merged #129 (list, filters, sources) + #132 (clicked status) |
| Q2 | **Send Review Request** button on every Reputation tab | Per-contact "Request review" only | Button on Overview/Requests opens a contact picker → the existing manual send route | #129 | same | merged #129 |
| Q3 | Per-channel request settings: **When to send after check-in** (Immediately / delay), **Until clicked, repeat this every** (Don't repeat / N days), **Maximum retries** (`ghl/08`, `ghl/09`) | One-shot send + 90-day cooldown (`cooldownDays`); no delay, no reminder | `googleReviewConfig.reminder {everyDays, maxRetries}` — **off by default** (`everyDays: null` = GHL's "Don't repeat"). A reminder is a QStash-scheduled re-send of the same request that stops when the request is clicked, feedback is given, the contact opts out, or retries run out. Delay-after-trigger not built (every trigger we have is already the "check-in" moment) | #132 | `reputation-reminders.spec.ts` (drives the reminder with a signed QStash POST; asserts stop-on-click, opt-out, retries, no double send) | merged #132 — **default off**; SMS-only; needs dedicated Twilio number + inbound webhook + Google review link; **enabling on a real sub-account is Hein's call** |
| Q4 | Default sender number per channel; SMS/Email/WhatsApp templates | `channel` (sms / whatsapp_template / whatsapp_manual) + `messageTemplate` + `whatsappTemplateId` on `googleReviewConfig` (Settings → Google reviews) | — (email review requests not built; SMTP exists but no email channel in the dispatcher — follow-up) | — | — | parity (SMS/WA) |
| Q5 | Review link settings; **Review Balancing** across platforms (`ghl/`Review Link) | **Shipped #81**: configured link + adopt-listing-link card (`review-url-card.tsx`; `gbp-review-request.spec.ts`) | Review balancing not building (Google only) | #81 | `gbp-review-request.spec.ts` | parity |
| Q6 | Reviews QR code | None | **Not building** in SP5 (the configured review link is copyable; a QR is a follow-up) | — | — | out of scope |

### Widgets

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| W1 | Widget editor: **Widget Type** List · Grid · Masonry · Carousel · Slider · Flash · Legacy (`ghl/15`) | **Shipped #79**: one widget per sub-account, **carousel only** (`public/embed/gbp-reviews.js`), public feed with origin allow-list | `layout: carousel \| grid \| list \| badge` on the widget config (dashboard select), served in the feed as `display.layout` and rendered by the same embed. Masonry/slider/flash: not building (grid and carousel cover them) | #121 | `gbp-widget-layouts.spec.ts` | merged #121 · live half **blocked: case 4-6894000042302** |
| W2 | Templates (light / dark / coloured themes) (`ghl/16`) | Namespaced CSS the site can override | `theme: light \| dark` on the config → `display.theme` | #121 | same | merged #121 · live half **blocked: case 4-6894000042302** |
| W3 | Max number of reviews | **Shipped #79** `maxReviews` 1–50 | — | #79 | `gbp-public-feed.spec.ts` | parity |
| W4 | **Minimum Ratings** filter | Deliberately absent — every rating is served (review-gating policy; mutation-proven in #79) | **Not building, on purpose** | — | — | intentional gap |
| W5 | Override Write-a-review link; Powered-by toggle | Feed serves Google's `writeReviewUri`; "Reviews from Google" attribution always rendered (policy) | Not building (attribution must not be removed) | — | — | intentional gap |

### Google Business Profile

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| G1 | **GBP Optimization**: listing dropdown, profile-completeness score (9/16 → 15/16), edit name/description/images/phone/categories/services/attributes/hours, Social Profiles, Scheduled Posts | Connect + pick one listing (`listing-picker.tsx`); nothing about profile content | **Not building profile editing in SP5** (writes to a live Google listing; SP8 owns GBP posts). Insights below are the SP5 GBP remainder | — | — | out of scope |
| G2 | Performance insights (views on Search/Maps, calls, website clicks, direction requests) — **not on GHL's Reputation surface** (GBP Optimization shows none) | None; no Performance API code (`provider/types.ts` has no insights method) | Step up: Insights tab — `fetchMultiDailyMetricsTimeSeries` behind the provider seam (fake + Google), impressions (Search/Maps × desktop/mobile), calls, website clicks, directions, conversations, bookings; range 7/28/90 days; fetched on demand, memoised in memory, not stored | #126 | `gbp-insights.spec.ts` | merged #126 · live half **blocked: case 4-6894000042302** (Performance API quota 0) |
| G3 | Location dropdown on the GBP page (multi-location accounts) | One listing per sub-account (`googleListing`); the picker shows every visible location but manages one | Insights location picker: every location the connection can see (existing discovery), defaulting to the sub-account's listing; viewing another location never changes the review listing | #126 | same | merged #126 · live half **blocked: case 4-6894000042302** |
| G4 | — | Live listing discovery on #1000 fails as "Couldn't load listings from Google (error)" — a quota-0 429 reads as a generic error | Step up: name the cause ("Google hasn't approved API access for this project yet") when Google answers quota 0 | #126 | unit test on the error mapping (`provider/google-http.quota.test.ts`, `lib/gbp/access-not-approved.test.ts`, `components/gbp/access-not-approved-text.test.ts`) | merged #126 (also: GBP provider refusals 502→424 so Cloudflare stops swallowing the reason) |
| G5 | Listings (Yext, resold) | — | Out (programme decision) | — | — | out of scope |

### Settings

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| S1 | Settings sub-nav: Reviews AI · Review Link · SMS / Email / WhatsApp Requests · Reviews QR · Spam · Integrations (`ghl/07`–`ghl/10`) | Settings → Google reviews (link, channel, template, cooldown, triggers) | Reputation → Settings tab: the existing review-request section + reply guidelines (c) + reminder settings (d) + link to connect/listing | #135 #132 | `reputation-ai-draft.spec.ts`, `reputation-reminders.spec.ts` | merged #135 (Settings tab, Reviews AI card) + #132 (Reminders card) |

---

## Build order and DAG

One PR each, specs first, in this order (each stacks on the last merged `main`):

| PR | Scope | Rows | Depends on |
|---|---|---|---|
| (a) | Reputation nav + page shell + Overview (tiles, trend, distribution, response coverage/time, requests vs gained, checklist) + `reviewRequests` log written by the dispatcher | N1 V1–V6 V8 | — |
| (b) | `reviewsAiEnabledByAgency` gate (5-step pattern) + fenced fake AI provider + sentiment classify-after-sync + per-review badge + Overview donut | R4 V7 | (a) |
| (c) | AI reply draft in the composer + reply guidelines setting | R5 R6 S1 | (b) (gate + AI seam) |
| (d) | Requests tab (list, filters, search, status from log + click/feedback) + Send Review Request picker + reminder drip (QStash, default off) | Q1–Q3 S1 | (a) |
| (e) | Widget `layout` + `theme` → feed `display` → embed renders grid / list / badge | W1 W2 | — |
| (f) | Insights tab: provider `fetchDailyMetrics` (fake + Google), location picker, quota-0 wording | G2–G4 | (a) (page shell) |

Sizes: (a), (b), (d) likely 500+ lines → `review-team`. (c), (e), (f) medium.

## Gates per PR

1. `pnpm ci:check` green locally; `pnpm check:tenancy` passes.
2. Playwright spec under `e2e/specs/`, mutation-proven — PR body shows it red against one deliberate break of production code. Never run local E2E while a CI E2E job runs (it purges the fixture sub-account); serialise on port 3100.
3. Every new tenant doc carries `agencyId` / `subAccountId` / `createdByUid`. **Target: no `firestore.rules` / `firestore.indexes.json` change** — every new collection is server-only (default deny, read through API routes) and every query single-field, like the GBP stack. If a PR does need one, rules deploy is a manual UNION of all open branches, then redeployed from `main` after merge, indexes included.
4. Blind `/review` (review-team for 500+ lines), one reviewer briefed to hunt unreachable paths (a route no UI calls, a setting nothing reads, a status nothing writes). Review prompt asks whether any added image contains real customer data. Fix rounds reviewed as their own target.
5. PR via REST (Heinvv10 token); `git log origin/main..HEAD` checked first; merge `--merge` + delete branch when CI green + APPROVED. Ledger Status + evidence updated.

## Decision summary (self-grilled 2026-09-14 from repo + live probes; Hein's overrides welcome)

**Verdict:** Proceed with constraints.

**Design concept:** "Reputation" is a reporting-and-assist layer over data LeadStack already owns — the synced `gbpReviews` cache and the review-request dispatcher. SP5 adds no new way to talk to Google or to customers except: an AI *draft* that a human must still post, and an opt-in reminder for requests the tenant already sends.

**Proven assumptions:**
- Reviews stay in the cache as long as syncs keep seeing them (retention deletes only reviews unseen for 30 days — `gbp-reviews.md` §Retention), so a multi-year trend from `createTime` is available whenever sync is healthy; when it is not, the Overview shows the same freshness state the reviews page does, never invented numbers.
- Sync writes to a cached review are `merge:true` except first creation (`lib/gbp/sync/store.ts:87-141`), so a cached `sentiment` field survives unchanged/updated passes without extra code; tombstone must null it explicitly (derived from deleted content).
- Every other external rail in CI runs on a fenced fake (GBP, WhatsApp settings, SMS, GCal — `ci.yml:226-251`); the AI seam follows the same fence (loopback URL + prod-build opt-in + fixture agency) and the deploy guard (`scripts/gbp-deploy-check.mjs`) refuses its env names.
- Performance API is quota 0 until approval (probe above) — (f) is fixture-only like reviews.

**Disproved (blind review of (a), 2026-09-14):**
- ~~The dispatcher is the single send path for review requests, so one write there captures every request.~~ It is the single path only for *Request review*, quote paid and deal completed (`lib/reviews/request.ts`). Review asks also go out, unlogged, as a review link pasted into a workflow SMS / WhatsApp / email step body, a WhatsApp template's variable or button (e.g. the `review_request` starter), a link pasted into a broadcast email, and the Conversations composer's "Ask for review" (or a typed link). (`{{reviewUrl}}` does not resolve in `lib/automations/merge-tags.ts` — it renders "" — so those asks carry a pasted link or an approved template.) (a) logged the dispatcher only and said so on the page. **Closed by (d1):** every one of those senders now logs through `logReviewRequest()`, detected by the configured URL in the rendered message (or the `review_request` template) where the send is initiated — see V6, Q1 and [reputation.md](../features/reputation.md#the-review-request-log).

**Remaining risks:**
- `OPENROUTER_API_KEY` is empty in production (memory, 2026-09-13): sentiment and drafts will show "AI not configured" on crm.crestahq.com until Hein sets it. Not a build blocker; stated on the page.
- Requests counted only from the first logged request (the dispatcher's first send after (a) deploys) — older requests left activities but no tenant key; not backfilled.
- Reminder drip (d) sends additional customer messages once a tenant enables it. It merges default-off (no message changes on merge); **enabling it on any real sub-account is Hein's call**.
- Response time uses Google's latest-reply time, not the first reply; labelled.

**Explicitly not building:** auto-responses / drip auto-reply (replies stay a human click), AI summary, video testimonials, competitor analysis, spam detection, manual reviews, review balancing, QR, masonry/slider/flash layouts, minimum-rating filter (policy), GBP profile editing and posts (SP8), Yext listings, email review requests.

**User-owned decisions, defaulted:** Reviews AI is a new opt-in agency gate (GHL sells it as an add-on; it spends the agency's OpenRouter credits) — default off. Reminder drip default off.

**Validation:** each PR's spec is mutation-proven red → green; browser frames of each tab on the fixture tenant under `evidence/sp5/<letter>-*/`; #1000 screenshots after the next approved deploy (this goal forbids deploying).

## Final state (2026-09-14)

All SP5 PRs merged, each with green CI and APPROVED blind review (review-team for the large ones, an unreachability reviewer on each, adversarial breakers on the billing and outbound-messaging PRs, every fix round reviewed on its own):

| PR | What | Rows |
|---|---|---|
| #122 | Reputation nav, Overview, request log (dispatcher) | N1 V1–V6 V8 |
| #121 | Widget layouts (carousel/grid/list/badge) + dark theme | W1 W2 |
| #126 | Insights + location picker; quota-0 named; GBP refusals 502→424 | G2–G4 |
| #128 | Flaky `feature-gates/route.gbp.test.ts` under box load | — |
| #129 | Every review-ask sender logged; Requests tab; Send Review Request | Q1 Q2 V6 |
| #124 | Sentiment + Reviews AI gate (never re-billed; 300 AI calls/day) | R4 V7 |
| #135 | AI reply drafts (human posts), guidelines, Settings tab | R5 R6 S1 |
| #132 | Reminders + click tracking — default off | Q3 S1 |

- **Deployed** 2026-09-14 17:48 SAST (`cde3b17`, Hein's go; deploy gate 393 files / 4392 tests). Walked on #1000: `evidence/sp5/prod-1000/` — Overview (no listing: Google quota 0), Insights, Settings (Reviews AI card, gate off), and Google Business now saying "Google hasn't approved Business Profile API access for this project yet." instead of "(error)". No `firestore.rules` / `firestore.indexes.json` change in any SP5 PR, so no rules deploy.
- **Evidence:** per-PR frames on the fixture tenant (`evidence/sp5/<letter>-*/`); #1000 after deploy in `evidence/sp5/prod-1000/` (no listing, so review metrics are empty there until the case is approved).
- **Production prerequisites:** `OPENROUTER_API_KEY` is empty on crm.crestahq.com (sentiment labels star-only reviews; drafts hidden until set). Reviews, replies, listing discovery and insights stay on the fake until case 4-6894000042302 is approved.
- **Reminders** are off for every tenant. Turning them on for a real sub-account is Hein's decision; they require a dedicated Twilio number with its inbound webhook configured, a Google review link, SMS channel and E.164 contact numbers.
- **Follow-ups (not built):** ~12 non-GBP routes still answer 502 with a JSON body the UI shows (Cloudflare replaces it); `lib/reviews/request.ts` and `lib/workflows/engine.ts` over 300 lines; `inboundWebhookConfigured` is only set by the webhook auto-config.
