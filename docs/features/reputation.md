# Reputation

A sub-account's **Reputation** area (sidebar → Reputation, `/sa/[id]/reputation`)
is a reporting layer over data LeadStack already owns: the synced Google review
cache ([gbp-reviews.md](gbp-reviews.md)) and the review-request log every
sender writes (below). It adds no new way to talk to Google or to customers.
Ledger and build order: [docs/parity/sp5.md](../parity/sp5.md).

Tabs today: **Overview** · **Reviews** · **Requests** · **Widgets** · **Insights**
(SP5 PRs a, d1, f). A later SP5 PR adds Settings.

- **Reviews** mounts the existing reviews inbox (`components/gbp/reviews-section.tsx`)
  unchanged — same route, filters, Sync now and reply. Members read; admins sync
  and reply. With the Google gate off, or before Google is connected and a listing
  chosen, it says so and links to **AI Agents → Google Business**, which stays the
  place to connect and pick the listing. When the deployment has no Google OAuth
  client configured (the same `google/status` check the Google Business page
  makes, admins only), the tab hides Sync now and Reply — they could only fail —
  and shows `rep-reviews-not-configured`; the synced reviews stay readable.
- **Widgets** mounts the existing widget editor (`components/gbp/widget-section.tsx`),
  admins only.

## Overview (SP5 a)

`GET /api/sub-accounts/[id]/reputation/overview?range=30d|90d|365d|all` (default
`90d`; anything else → 400 `invalid_filter`, `field: "range"`). Any active member
(`requireSubAccountMember`). Aggregates only — the response carries no review
text, reviewer name, contact id or phone number. The numbers are computed by the
pure `computeOverview` in `lib/reputation/overview.ts` (unit-tested there; the
route test proves the same numbers over seeded docs).

**Review metrics** are returned only when the agency's Google gate is on, Google
is connected and a listing is selected; otherwise `reviews: null` and
`reviewsUnavailable` is `gate_off` / `not_connected` / `no_listing` (checked in
that order). The request half is always returned. A connection flagged
reconnect-required still serves its cached reviews, with `health:
"reconnect_required"` — as the reviews inbox does.

The reviews are **exactly the inbox's set**: `loadServedReviews`
(`lib/gbp/sync/served.ts`), which both routes call — active reviews of the
current listing, re-seen within Google's 30-day storage limit, from the newest
**500** stored records (`truncated.reviews` when there were more; tombstones count
toward the 500). Single-field query on `createTime`.

### Definitions and their honesty caveats

| Metric | Definition |
|---|---|
| Range | The last 30 / 90 / 365 days ending now, compared with the equal-length range before it. `all` starts at the oldest review or request and has no previous period. `from` inclusive, up to now. |
| Buckets | ISO weeks starting **Monday 00:00 UTC** for spans up to 90 days, calendar months starting on the **1st, 00:00 UTC** beyond. Contiguous (empty buckets included); the first may start before `from` and counts only what is in range. |
| Average rating / reviews | Over reviews created in range (star ratings 1–5). The previous period's figures are `null` when it had no reviews — the page then says there is nothing to compare, never "+7". A bucket with no reviews has no average (left out of the chart, never drawn as 0). |
| Listing rating | `listing.averageRating` / `totalReviewCount` are Google's own figures from `gbpSummary`, passed through `publicSummary` exactly as the reviews inbox serves them (null past 30 days without a successful sync). They cover the whole listing, not the range. |
| Star distribution | Count per rating, 1–5, in range. |
| Response coverage | Replied ÷ reviews in range; `null` with no reviews. |
| Time to latest reply | `reply.updateTime − createTime`, average and median in hours over replied reviews in range. **Google reports only the latest reply time**, so an edited reply moves it — the label says so. Replies with a missing or earlier-than-review time are excluded and counted (`replyHours.excluded`); they still count as replied for coverage. Trended by the review's bucket. |
| Requests sent | Rows in `subAccounts/{id}/reviewRequests` (below) with `status: "sent"` and `sentAt` in range — **from every sender** (SP5 d1) — by channel (`sms` / `whatsapp` / `email`) and by source (`dispatcher` / `workflow` / `broadcast` / `inbox`). Review asks whose send failed are counted apart (`requests.failed`) and said on the card, never in "sent" or the trend. Rows written before d1 (dispatcher only, channel `whatsapp_template` / `whatsapp_manual`, no `source`) read as `whatsapp` / `dispatcher`. `countingSince` = the **first logged request** (not the deploy date — a sub-account that sends nothing for a while starts later); requests before it were not logged and are not backfilled — and before d1 only the dispatcher's sends were logged. The previous-period count is given only when the first logged request is no later than the previous period's start. At most 2,000 rows per request (`truncated.requests`). |
| Requests vs reviews | Shown **side by side per bucket, never attributed**: Google gives no link between a request and a review. |
| Health | `health` is the reviews inbox's `deriveHealth` result (via `publicSummary`), so both pages show the same stale / partial / reconnect / sync-pending / error / never-synced state and banner. |

### Checklist

Booleans from real state only, recomputed on every request — no stored progress:
Google connected (and not flagged reconnect-required), a listing selected, a
review link configured (`resolveReviewUrl(sub).configured`), a widget exists
(`gbpWidgetMeta.publicId`), and at least one review request **sent** (a log row
with `status: "sent"` — single-field equality query; a failed ask alone does not
tick it).

## Requests (SP5 d1)

`/sa/[id]/reputation/requests` reads `GET /api/sub-accounts/[id]/reputation/requests`
(any active member; `requireSubAccountMember`): the log, newest first, **50
matching rows a page** with **Load more** (`cursor` = the last row's id). Filters
`status` (`sent` / `failed`), `channel` (`sms` / `whatsapp` / `email`) and `source`
run on the server, applied while scanning one single-field query
(`orderBy sentAt desc` + `startAfter`) in batches of 100 — no composite index. A
request scans at most 1,000 rows; a sparse filter can return a short (or empty)
page with a cursor to keep looking, and the page says so. Anything else in a
filter → 400 `invalid_filter` with `field`. Each row: `id, contactId,
contactName, channel, source, trigger, status, failureKind, sentAt` — the name
is joined at read time from the contact doc, **only when that contact is in this
sub-account** (else null, shown as "Deleted contact"). For a **territory-scoped
collaborator** (`loadEffectiveTerritoryScope`, the same rule as
`territoryDenialForContact`) a contact outside their territories — or with no
territory, or no longer existing — keeps its row but loses its id and name
(shown as "Outside your territories", no link); Global contacts stay visible.
Never a message body, phone number or email address. The **search** matches
contact names over the rows already loaded, and the page says so. Selecting
the **Failed** filter says what it lists: provider rejections from workflows,
broadcasts and the inbox — a Request review that could not be sent is not
logged; the dialog below shows why instead.

**Send Review Request** (Overview and Requests headers) opens a dialog with the
shared contact picker (`components/quotes/contact-picker.tsx`, this
sub-account's contacts, territory-filtered like every contact list), then POSTs
the existing manual route `/api/comms/review-request/send` — the dispatcher,
`trigger: "manual"`, which skips the cooldown as it always has. Its answer is
shown inline in plain words (`components/reputation/send-result.ts`: e.g.
`not_configured` → "Set your review link first …"); a successful send reloads
the page's data, and Send stays off for the contact just sent to (re-picking
them does not re-arm it) until the dialog is reopened. Contacts
that fail to load say so rather than showing an empty picker.

Statuses are what LeadStack can observe truthfully: **sent** and **failed**.
Delivered / read are not wired to the log; clicked / feedback (`clickedAt`,
`feedbackAt`) and reminders are later SP5 work (ledger Q1/Q3) — nothing writes
them yet.

## Sentiment (SP5 b)

Each synced review can carry a cached label, `sentiment {label, method,
basisHash, model, at}` on its `gbpReviews` doc — `positive` / `neutral` /
`negative` — and `sentimentAttempt {basisHash, failures, lastAt}` when the AI
failed on its current content.

- **Gate:** the agency's `reviewsAiEnabledByAgency` ("Reviews AI", opt-in,
  plan-managed, not pre-ticked), on top of `googleEnabledByAgency`. It spends
  the agency's OpenRouter credits. Switching it off tears nothing down: labels
  stay until each review's own lifecycle clears them; no new review is sent.
  Because it is a plan gate, **applying a Client Billing plan that does not
  include Reviews AI switches it off** for that sub-account on the next plan
  apply, like every other plan gate.
- **When it runs — never inside a request:** classification is decoupled from
  the sync (Cloudflare cuts origin requests at 100 s; QStash would retry a slow
  cron). The 6-hourly cron and Sync now respond first and then, via Next's
  `after()` (`lib/reputation/sentiment-after.ts`; the same mechanism the
  Google Calendar push uses in the standalone build; the three routes export
  `maxDuration = 300`), classify a tenant **iff** both gates are on and AI is
  configured, **and** either its run created or updated reviews, or the last
  **complete** run (`private/sentimentLease.lastCompleteAt`) is more than 24 h
  old or there has been none. A run is complete only if it finished normally
  — not thrown, not stopped by a gate, the listing, the lease, an AI failure,
  a save failure, the daily cap or the time budget — **and** the 100-per-run
  cap left nothing behind, no text review is waiting out its retry hour, and
  AI is configured (or there was no text review). That covers a killed, stopped or capped run and reviews waiting out
  their retry hour; switching Reviews AI **on** clears `lastCompleteAt`, so the
  next sync backfills. Otherwise a sync costs the sub-account read. **One
  deadline per request:** the cron, Sync now and Analyse now pass their
  request's start + 240 s through every tenant they classify — no fresh 240 s
  per tenant.
  **Analyse now** on the Overview (`POST
  /api/sub-accounts/[id]/reputation/sentiment/run`, admin, both gates, a
  listing, once a minute) takes the lease and the cooldown in one transaction
  — a press refused as `busy` does not burn the minute — answers **202**
  `{started, aiConfigured}` and classifies after the response; the card
  re-reads the overview every 3 s (up to a minute) until the lease is free and
  a new `lastRun` appears, then says what it did — or why it stopped (Reviews
  AI or Google switched off, no listing, the listing changed, "The AI provider
  failed — try again later", an unusable AI answer, a label that could not be
  saved (`save_failed`), "Daily AI limit reached — continues tomorrow", the
  time budget, an error) — or, past the minute, "The
  result isn't in yet — reload later". Refusals carry their own message:
  Reviews AI off / Google off (403 `gate_off`), no listing (409
  `no_listing`), `busy`, `too_soon`.
- **What is labelled:** the reviews inbox's own set (`loadServedReviews`:
  active, current listing, within Google's 30-day limit — so the newest 500
  stored records). **Star-only** reviews (no or blank comment) are labelled
  from the stars — 4–5 positive, 3 neutral, 1–2 negative, `method: "rating"`,
  no AI call, written in transactions of up to 100. Reviews **with text** go to
  the AI (`method: "ai"`, `model`) — **one review per call**
  (`REVIEWS_AI_BATCH = 1`), so no member of the public's text shares a prompt
  with another review it could try to steer.
- **What is billed — honestly:** a review is sent to the AI once — again only
  if it is edited, **or if its cached copy was deleted and re-synced** (the
  listing changed, Google was disconnected or switched off, or Google's
  30-day storage limit removed it); the label lives on the cached review doc,
  so it goes with it. A tombstone keeps it (below), so a review removed and
  restored unchanged is not re-sent. A bad AI answer is tried at most 3
  times; a failed call is retried after an hour. A re-sync of unchanged
  reviews never re-bills.
- **Spend bounds:** at most **300 AI calls per sub-account per UTC day**
  (`DAILY_AI_CALL_CAP`, a constant), counted in
  `private/sentimentUsage {day, calls}` in the same transaction that starts
  each call — over the cap the run stops and the rest waits for tomorrow (a
  call is counted on the UTC day it starts, so one in flight across midnight
  can make one extra call fall in a calendar day); and a **240 s budget** per
  request, after which no new call starts.
- **Before each call** one transaction (`beginCall`,
  `lib/reputation/sentiment-calls.ts`) re-reads the lease, the sub-account,
  the daily usage and the review, and either **stops the run** (the lease is
  no longer this run's — only its owner can renew it; Reviews AI or Google
  switched off; the listing changed; the daily cap), **drops the review**
  (changed, removed, labelled meanwhile, in its retry hour or given up), or
  renews the lease, counts the call and writes a **strike** on the review
  (`sentimentAttempt.failures + 1`, `lastAt` now), immediately before the
  call. After it, a label is written (clearing the strike) if the review still
  has the classified content — or was tombstoned during the call (a 3-value
  label, no content; readers hide tombstones). **Only two things are a
  strike:** HTTP **403** (the provider refusing this review — moderation) and
  an **unusable answer** (a 200 with content we cannot use: unparseable,
  invalid label, unknown / duplicated / missing id); the run then stops as
  `ai_bad_answer` ("The AI gave an unusable answer for a review — it will be
  retried, at most 3 times"). **Every other failed call is transient** — no
  response (network, DNS, connect), our timeout or abort, a missing key, 400
  (e.g. an invalid model), 401, 402, 404, 408, 422, 429, any other 4xx, 5xx,
  a 200 with no content or with an error body: a configuration or provider
  problem, not the review's fault. It is **not a strike** (its `lastAt` still
  spaces the retry by an hour), the run stops as `ai_error`, and the Overview
  shows "The AI provider failed on the last run — check the agency's
  OpenRouter key/credits". **A review that always hits a transient error is
  never given up:** it costs at most one call an hour, blocks nothing (it
  queues after fresh reviews), and keeps the amber line showing until a call
  succeeds. Failed calls are logged with their HTTP status, never the body. A
  label that comes back but cannot be written stops the run as `save_failed`
  and keeps the strike; a provider that cannot be obtained stops it as
  `ai_error`. If un-counting a transient failure's strike itself fails, the
  strike stays — conservative.
  **Queue order:** fresh reviews first (newest first), then reviews already
  tried, longest-waiting first — so one troublesome review can never block
  the backlog; it costs at most one call an hour until it is given up. The
  whole call — headers and body — gets 60 s; at the deadline the request is
  **aborted** (callAi's optional caller signal, armed through the body read;
  the provider may still bill an aborted call), well under the 5-minute
  lease. Only one call is ever in flight per sub-account, so switching a gate
  off lets at most that one call finish.
- **Failures:** a review is tried again at most **once an hour** (checked
  against the clock at that moment) and — for strikes (a 403 or an unusable
  answer) — **at most three times** per content, then counted as
  **"couldn't be analysed"**, apart from "not analysed yet". An edit starts a new count; a success clears it.
- **Cap:** at most 100 reviews per run, in queue order (fresh first, newest
  first; then tried ones, longest-waiting first); the rest wait for the next
  run (a capped run is not complete, so the next sync continues).
- **Clocks:** lease expiry compares instance clocks; production runs one app
  instance on one host, and dev/CI instances are fake-fenced to the fixture
  agency, so skew between writers is not a concern here.
- **Stale labels are never shown:** a sync edit overwrites a review's content
  but keeps its `sentiment` (blanking it in the upsert would re-bill on every
  owner reply, since the content hash covers the reply). So every reader —
  the reviews route and the overview — shows a label only when its
  `basisHash` matches the review's current stars + comment; otherwise it reads
  as absent until re-classified (`lib/reputation/sentiment-basis.ts`).
- **The AI call** (`src/lib/reputation/ai/`): OpenRouter via `callAi` on the
  default model, temperature 0. Review text is untrusted: it is sent only as a
  JSON string value inside a data object, the system prompt says so, and a
  batch-local id ("1") is used — no document id leaves the server.
- **Not configured:** with no `OPENROUTER_API_KEY` (production today) only
  star-only reviews are labelled; text reviews wait, and the Overview says
  "AI isn't configured on this deployment". Dev/CI use the fenced fake
  (`REVIEWS_AI_PROVIDER=fake`, docs/environment.md).
- **Lifecycle:** an edit re-classifies (new basis). A **tombstone keeps**
  `sentiment` and `sentimentAttempt` — a 3-value label and hashes, no review
  content — so a review restored unchanged is labelled again at once without
  an AI call, and its strike count survives; readers show nothing for a
  tombstone (no stars, so no current basis). Retention deletion removes them
  with the doc.
- **Where it shows:** a badge on each review in the reviews list (Reputation →
  Reviews and AI Agents → Google Business — the same component; the title says
  "From the star rating" or "AI-classified"), and the Overview's sentiment
  card: a donut over in-range reviews plus "N not analysed yet" and "N
  couldn't be analysed", with gate-off / not-configured / none-analysed
  states. The reviews route serves only `{label, method}`; **the public feed
  never carries sentiment** (its serializer is an allow-list; a test pins it).
- **Limits:** labels are a model's reading of short customer texts —
  translated reviews are classified on the text Google returned (translation
  plus original); a mixed review gets one label. No per-aspect sentiment, no
  AI summary (SP7).

## Insights (SP5 f)

> **Live status: blocked — case 4-6894000042302.** The Business Profile
> Performance API is enabled on the project but answers 429
> `RESOURCE_EXHAUSTED` with a quota of 0 until Google approves the case
> (probed 2026-09-14). Everything below is proven on the fenced fake provider;
> on a live deployment the tab shows "Google hasn't approved Business Profile
> API access for this project yet."

`GET /api/sub-accounts/[id]/reputation/insights?location=locations/…&range=7d|28d|90d`
(default `28d`; anything else → 400 `invalid_filter`, `field: "range"`).

- **Who:** any active member, for the sub-account's selected listing. The
  agency's Google gate, Google connected (not reconnect-required) and a
  listing are required — 403 `gate_off` / 409 `not_connected` /
  `reconnect_required` / `no_listing`.
- **Location (G3):** defaults to `googleListing.locationName`. Any other value
  is **admin only** (403 `location_admin_only` — the locations list behind the
  picker is admin-only too) and is never trusted: it must match
  `locations/{id}` (else 400 `unknown_location` before any Google call) and be
  a location THIS connection can see — the server walks the existing discovery
  (20-page bound): not there → 400 `unknown_location`, walk truncated → 400
  `unverifiable_truncated`. Viewing another location **never changes the
  listing** — the route writes nothing (route test and E2E compare
  `googleListing` before and after).
- **Data:** one `fetchDailyMetrics` call (through `withGbpAccess`) for the nine
  metrics — impressions on Search / Maps × desktop / mobile, call clicks,
  website clicks, direction requests, conversations, bookings — covering the
  current and previous windows. **Nothing is stored**: the body lives in an
  in-memory memo for 10 minutes per sub-account + connection (`connectedAt`) +
  current listing + location + range + window end, per instance
  (`lib/gbp/insights.ts`); a refusal is never kept. An entry for another
  location exists only after discovery passed for that same connection and
  listing. The memo holds Google's numbers (and a discovered title) only —
  `isListing` and the listing's title are read fresh on every request.
- **Numbers** (pure `lib/reputation/insights.ts`, unit-tested): the window is
  the last 7 / 28 / 90 whole **UTC days ending yesterday** (today is still
  being counted), compared with the equal span before. Tiles: Search views
  (desktop + mobile search), Maps views (desktop + mobile maps), Calls,
  Website clicks, Direction requests, and Conversations / Bookings only when
  either period is non-zero; each shows the change vs the previous period.
  Charts: views per day (search + maps) and actions per day (calls + website +
  directions); the desktop / mobile split of views. A day Google returns
  without a value is 0 (Google omits zeros); a missing day is drawn as 0, and
  `lastDataDate` (the latest day Google returned — a day it sent with a zero value counts) is shown as "Google's data runs to
  …" because Google reports with a delay. Views are Google's impressions —
  unique people per day.
- **Response:** `{location: {name, title, isListing}, range, window: {current,
  previous}, totals, previousTotals, groups, daily, lastDataDate}` — no tokens,
  account names or ids beyond the location's own resource name.

**UI** (`components/reputation/insights.tsx`, `insights-parts.tsx`; every
state rendered in `insights.test.ts`): `rep-insights-location` (a select of
every visible location for admins — from `GET …/google/locations`, falling
back to the listing alone if that call fails, with `rep-insights-locations-error`
under it saying why — the "not approved" sentence for `access_not_approved`;
plain text for members),
`rep-insights-range`, `rep-insights-tiles` / `rep-insights-tile-<key>` (+
`-value`, `-note`), `rep-insights-chart-views`, `rep-insights-chart-actions`,
`rep-insights-devices`, `rep-insights-data-through`, `rep-insights-other-location`,
and the states `rep-insights-gate-off`, `-not-connected`, `-no-listing`,
`-not-approved` (Google's quota-0 refusal), `-error` (its own sentence per
refusal code), `-loading` (also while the sub-account itself is loading, so
gate-off never flashes), `-empty`.

**Tests:** `lib/reputation/insights.test.ts`; `app/api/sub-accounts/[id]/reputation/insights/route.test.ts`
(real tenancy, discovery and fake provider; expected numbers computed in the
test from the scenario's patterns; memo; nothing stored); provider —
`provider/google-insights.test.ts` (URL, parsing, fail-closed),
`provider/fake-insights.test.ts`; quota-0 mapping — `provider/google-http.quota.test.ts`,
`lib/gbp/access-not-approved.test.ts`, `components/gbp/access-not-approved-text.test.ts`;
`e2e/specs/gbp-insights.spec.ts` (tiles equal totals computed from the
scenario, switch to the second fixture location, listing unchanged in
Firestore, an invisible location refused, "not approved").

## The review-request log

`subAccounts/{id}/reviewRequests/{auto}` has **one writer**,
`logReviewRequest()` (`lib/reviews/request-log.ts`). Row fields:
`{agencyId, subAccountId, createdByUid, contactId, channel: sms|whatsapp|email,
source: dispatcher|workflow|broadcast|inbox, trigger, status: sent|failed,
failureKind, messageSid, sentAt, clickedAt: null, feedbackAt: null}`.
`createdByUid` is the person who sent it (a manual Request review, an inbox
message — or whoever scheduled it), else a label: `"review-request"`
(dispatcher auto triggers), `"workflow"`, `"broadcast"`. `trigger` is the
dispatcher's (`manual` / `quote_paid` / `deal_completed`), null for the others.
`failureKind` is a short machine kind (a provider message can quote a phone
number, so free text becomes `send_failed`). A failed log write is logged by
kind (`[reviews/request-log] reviewRequests write failed source=… kind=…`) and
never fails the send.

Who writes, each once, at the level that **initiates** the send — never in a
transport, so no send is counted twice:

| Source | Where | When |
|---|---|---|
| `dispatcher` | `maybeSendReviewRequest` (`lib/reviews/request.ts`): Request review (contact profile, Send Review Request), quote paid, deal completed | every successful send; refusals and failed sends write nothing (unchanged from SP5 a) |
| `workflow` | `runStep` (`lib/workflows/engine.ts`) for `send_sms` / `send_email` / `send_whatsapp` / `whatsapp_template` steps | the step's rendered content is a review ask: sent, or failed after a provider was called (`failureKind` = the step's error token) |
| `broadcast` | `/api/broadcasts/email/step`, per recipient | the rendered email is a review ask: sent, or failed at the email provider; a QStash redelivery of a settled recipient logs nothing |
| `inbox` | `/api/comms/{sms,whatsapp,email}/send`, `/api/comms/whatsapp/send-template`, and the scheduled-message worker (`lib/server/scheduled-messages/fire.ts`) | a person's message is a review ask: sent, or failed after a provider was called (`failureKind` = the provider's code, `outcome_unknown`, or `send_failed`) |

**One failure rule for every sender:** a `failed` row means a provider was
actually called and the send failed there. A send refused before anything went
out — opt-out, no phone, quota, an agency gate, a shut WhatsApp window, a
template not approved on this rail, missing credentials, or a rail refusing on
its own rules (the bridge's quiet hours and caps) — is not a request and writes
nothing. (The dispatcher, unchanged from SP5 a, writes successful sends only.) The inbox knows which is
which from `SendRefusal.attempted` (set by the conversation send service); the
WhatsApp dispatchers mark a result `attempted` only when they called a
provider. A **thrown** send error counts only when it carries the provider-attempt
mark (`lib/comms/provider-attempt.ts`), set where the carrier call happens — the
SMS seam (`sms/select.ts`), Twilio's `messages.create` (and its 21610 mapping),
SMTP's `sendMail` (inside `sendSmtpEmail`, after every header, address, settings,
DNS and private-IP check) and Resend's `emails.send` (and its `{ error }` / no-id
results) — never inferred from a catch: a throw before any provider call (no
credentials, shared SMS switched off, the fake's fixture fence, an address SMTP
refuses) logs nothing.
A scheduled send that throws is not logged: nothing says whether a provider
was reached.

**What makes a message a review ask** (`isReviewAsk`, `lib/reviews/review-ask.ts`):
any rendered part — body, email subject, a WhatsApp template's filled body or a
URL button — contains the sub-account's **configured** review URL
(`resolveReviewUrl(sub).configured`), or the WhatsApp template is the gallery's
`review_request` starter (its name or its unedited body). Detection is on the
rendered text because `{{reviewUrl}}` does not resolve in workflow or broadcast
merge tags (it renders ""), so those asks carry a pasted link. The composer's
"Ask for review" inserts the link into a normal message, so the URL check
covers it. A `send_whatsapp` step is judged on what the window made it send:
its text, or its template. Not covered: Messenger / Instagram messages, Web Chat
operator messages, missed-call text-back, AI replies and booking messages —
none is a review-request channel.

The check is deliberately literal, so it misses some asks:

- **Exact substring** of the configured URL: the same link written differently
  — a trailing slash added or dropped, `http` vs `https`, other casing — does not
  match.
- **Configured, not proposed:** a pasted link equal to the listing's proposed
  `newReviewUri` counts only once an admin has adopted it as the configured link.
- **Tracked links:** a tracked `/l/…` link pasted in place of the review URL
  (even one that redirects to it) does not contain the review URL, so it is not
  detected.
- **Template URL buttons with a `{{n}}` suffix:** the button is checked as
  stored (`https://…/{{1}}`), not with the suffix filled in, so a review link
  split across the button's base URL and its variable is not detected.

Detection runs inside the logging code's own `try`: a malformed stored template
(odd `buttons`, a non-string body) is skipped or logged by kind, and can never
throw into a send or abort a workflow step. In `runStep` and the broadcast
worker the row is written **after** the idempotency marker (the run's history
entry; the recipient's settled send row), so no extra Firestore work sits
between the provider send and the marker.

Server only: no client rule (default deny), no index.

## Tests

Sentiment: `lib/reputation/sentiment.test.ts` + `sentiment-flight.test.ts`
(eligibility, cap, lease, never re-billed, mid-flight edits, tombstones,
through the sync), `lib/reputation/ai/*.test.ts` (fence, strict validation),
`…/reputation/sentiment/run/route.test.ts`, the feed's
`route.sentiment.test.ts`, the badge and card component tests, and
`e2e/specs/reputation-sentiment.spec.ts`.

- `lib/reputation/overview.test.ts` — every definition above.
- `app/api/sub-accounts/[id]/reputation/overview/route.test.ts` — real
  require-tenancy, real sync over the fake provider, in-memory Firestore:
  non-member / other-sub-account 403, invalid range 400, numbers over the synced
  reviews, tombstoned / other-listing / past-retention excluded, another
  sub-account's log never counted, gate-off / not-connected / no-listing,
  checklist.
- `lib/reviews/request-log.test.ts`, `app/api/comms/review-request/send/route.test.ts`
  — the dispatcher's row, the actor, and the unchanged send.
- `lib/reviews/review-ask*.test.ts` — the review-ask rule, and each sender at its
  own seam (real `runStep`, real send routes and worker, real broadcast step, in-memory
  Firestore): one dispatcher send = one row, one workflow send = one row, a message
  without the URL = none, failures by kind.
- `app/api/sub-accounts/[id]/reputation/requests/route.test.ts` — the list: tenancy,
  filters, paging with no gap or repeat, the scan cap, names from this sub-account only.
- `components/reputation/*.test.ts` — every UI state (jsdom).
- `e2e/specs/reputation-overview.spec.ts` — sync the fake's reviews, two real
  manual sends through the fenced fake SMS rail, the tiles equal the numbers
  computed from that data; the sidebar entry; the gate-off state on the secondary
  fixture.
- `e2e/specs/reputation-requests.spec.ts` — through the fenced fake SMS rail: a
  Send Review Request dialog send, a workflow `send_sms` step carrying the URL (real
  engine, signed step), the composer's "Ask for review", and a plain message; the
  Requests tab lists exactly the three asks by source and Overview shows 3.
