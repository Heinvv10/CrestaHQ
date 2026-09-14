# Reputation

A sub-account's **Reputation** area (sidebar → Reputation, `/sa/[id]/reputation`)
is a reporting layer over data LeadStack already owns: the synced Google review
cache ([gbp-reviews.md](gbp-reviews.md)) and the review-request log every
sender writes (below). It adds no new way to talk to Google or to customers,
except review-request reminders — off unless an admin turns them on (SP5 d2).
Ledger and build order: [docs/parity/sp5.md](../parity/sp5.md).

Tabs today: **Overview** · **Reviews** · **Requests** · **Widgets** · **Insights** ·
**Settings** (SP5 PRs a, d1, f, d2).

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

Statuses are what LeadStack can observe truthfully: **sent**, **failed** and —
for requests sent while reminders are on, over SMS or in-window WhatsApp —
**clicked** (SP5 d2, below; the Clicked filter lists them). The **Reminders**
column shows how many reminders went of the maximum and the next date, or why
they stopped (the reasons below); "—" (with a tooltip and a legend) means the
request has no reminders.
Delivered / read are not wired to the log. `feedbackAt` is reserved: the
private feedback page (`/r/[token]`) is not sent by any sender, so nothing
writes it.

## Reminders and click tracking (SP5 d2)

GHL's "Until clicked, repeat this every N days / Maximum retries". Set in
**Reputation → Settings** (the Google reviews section, also on Settings →
Messaging) as `googleReviewConfig.reminder = {everyDays: 1..7 | null,
maxRetries: 1..5}`, saved with `PATCH /api/sub-accounts/[id]/google-review`
(admins; needs a saved review link; writes only `googleReviewConfig.reminder`
and `updatedAt` by field path). The form's POST keeps a stored reminder (merge
write) and validates one when given. **Off is the default**: no `reminder`, or
`everyDays: null` ("Don't repeat"). Enabling it on a real sub-account is Hein's
decision.

**At most every 7 days** (GHL allows 30): each reminder is one delayed QStash
message, and the plan's maximum delay is unconfirmed — the same cap scheduled
messages use. Raise it only once that is confirmed.

**Turning reminders on needs** (both config routes refuse otherwise, with a
`code`): the review channel is **SMS** (`reminders_sms_only` — a WhatsApp
template's link is fixed, so a click can't stop it and the same template would
repeat, a WhatsApp quality risk; an in-window WhatsApp message dies when the
24-hour window closes); a **dedicated SMS number** on the sub-account
(`reminders_need_dedicated_number` — on the shared sender inbound SMS isn't
stored, so a reply like "please stop" could never stop them); **link tracking**
on the deployment
(`AUTOMATIONS_TOKEN_SECRET` and `NEXT_PUBLIC_APP_URL`, `reminders_need_tracking`);
and a **Google review link** (`reminders_google_link_only` — host exactly
g.page, search.google.com, maps.app.goo.gl, google.com, www.google.com or
maps.google.com). Switching them off needs none of it. While reminders are on,
the Messaging form can't save a non-Google link either (turn reminders off
first), and a tracked link never redirects to anything but a Google review
host.

**With reminders off, nothing changes** — no request id is chosen early, no
link is rewritten, no field is added to the log row, nothing is scheduled.
`lib/reviews/request-reminder.test.ts` pins the SMS body and the row keys byte
for byte, and `e2e/specs/reputation-reminders.spec.ts` asserts the real body.
The same holds, with reminders on, for any send they can't apply to: a
non-SMS channel, the shared sender, or no tracking on the deployment — today's
body, no reminder, never a send failure.

**With reminders on**, only SMS requests from the dispatcher's own senders —
Request review, Send Review Request, quote paid, deal completed; never
workflows, broadcasts or inbox messages — change:

- The request's log id is chosen before the send and the body's
  `{{reviewUrl}}` becomes the tracked link
  `${NEXT_PUBLIC_APP_URL}/rr/{subAccountId}.{requestId}.{hmac}` (signed with
  `AUTOMATIONS_TOKEN_SECRET`, domain-separated from tracked-link tokens) — the
  one change a customer sees, and only while reminders are on.
- The row gains `tracked`, `reminder {everyDays, maxRetries, attempts: 0,
  nextAt, state: "scheduled", stopReason: null, lastAttemptAt: null}` and
  `toHash` (SHA-256 of the number it went to — never the number). The
  contact's other `scheduled` requests stop (`superseded`): one chain per
  contact. Reminder 1 is published to QStash (`POST /api/cron/review-reminder`,
  `{subAccountId, requestId, attempt}`, delay `everyDays`, dedup
  `rr_{requestId}_{attempt}`). Superseding re-reads each older request in a
  transaction and stops it only if it is still `scheduled` — never a worker's
  stop or one mid-send. A failed publish never fails the send: the
  reminder is stopped with `schedule_failed` (that write is retried once, then
  logged by kind with `console.error`).

**`/rr/{token}`** (public; limited to 60 an hour per client, keyed like the GBP
feed — `cf-connecting-ip` only with `TRUST_CF_CONNECTING_IP=1`, else
`x-real-ip`, else the left-most `X-Forwarded-For` — with least-recently-used
eviction, never a wholesale clear; reads no identity header): a valid token for
a tracked request 302s to the sub-account's **configured** https review link as
it is now. Only a person's **GET** counts as a click and stamps `clickedAt`
(once; later clicks keep the first time): a **HEAD**, or a known link-preview
fetcher (facebookexternalhit, WhatsApp, Slackbot, Twitterbot, TelegramBot,
Googlebot, bingbot, SkypeUriPreview, LinkedInBot, Discordbot, Applebot, anything
saying "preview"), is redirected without one. The list can miss an SMS app that
fetches previews with a browser user agent; that fails safe — it only ends the
request's reminders early. Anything else — forged, unknown, untracked, no
usable Google review link — is a 404, never a redirect. It fires no workflow
trigger.

**The reminder worker** (`lib/reviews/reminder-run.ts`, behind the signed
route; its rules in `lib/reviews/reminder-checks.ts`) is idempotent under
QStash redelivery: in one transaction the request must still be `scheduled`
with exactly `attempt − 1` reminders sent, and the attempt is claimed
(`attempts = attempt`, state `sending`) before anything is sent — a redelivered
or concurrent message finds the claim and sends nothing. In that transaction
it stops without sending (state `stopped`, or `done` for retries) when:

| Reason | When |
|---|---|
| `clicked` / `clicked_other` | this request was clicked, or any of the contact's requests (an older one included) was clicked after this one was sent |
| `archived` / `automations_paused` | the sub-account is archived, or its automations are paused |
| `reminders_off` | reminders are off in the config now (or it was cleared) |
| `auto_send_off` | a quote-paid / deal-completed request whose auto-send (`enabled` + its trigger) is now off — manual requests are unaffected: `enabled` gates only auto sends |
| `not_configured` / `channel_changed` | the review link is gone or no longer a Google review link; the channel is no longer the request's (the dispatcher's reminder mode re-checks it too) |
| `shared_sender` / `tracking_unavailable` | the sub-account is on the shared sender now, or tracking is gone |
| `contact_deleted` / `phone_changed` | the contact is gone, or their number no longer matches `toHash` |
| `replied` | the contact sent any inbound SMS or WhatsApp message since the request — only the newest 20 messages per thread are read, so a reply older than 20 of the tenant's own messages to that contact is missed |
| `superseded` | the dispatcher sent the contact a newer request |
| `retries_exhausted` | the lower of the request's maximum and the config's maximum now is reached (`done`) |

Otherwise it re-sends through the dispatcher in **reminder mode** — the same
link and channel rules, the opt-out and gate checks, the cooldown skipped for
this request only, no new log row — and records the attempt on the request. A
dispatcher refusal stops it with that reason (`opted_out`, `no_phone`,
`send_failed`, …): **a failed send ends that request's reminders** — the safe
direction. After the last reminder the state is `done` / `retries_exhausted`;
otherwise the next is scheduled. A crash mid-send leaves `sending` — never a
second message; the Requests tab shows a `sending` older than 15 minutes, or a
`scheduled` more than a day past its next date (its message was lost), as
"Stopped — outcome unknown" (display only).

The Overview's requests card shows clicks among tracked requests only
("Clicked: X of Y tracked requests"); the Requests tab's Clicked filter is the
same rule (tracked and clicked).

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
Firestore, an invisible location refused, "not approved"). Mutation record:
`.sp5-orch/f-mutations.md` (orchestrator).

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
Dispatcher sends made while reminders are on also carry `tracked` and
`reminder` (above); the reminder worker updates `reminder`, and `/rr/` sets
`clickedAt` — nothing else writes to a row after it is logged.

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
  fixture. Mutation record: `.sp5-orch/a-mutations.md` (orchestrator).
- `e2e/specs/reputation-requests.spec.ts` — through the fenced fake SMS rail: a
  Send Review Request dialog send, a workflow `send_sms` step carrying the URL (real
  engine, signed step), the composer's "Ask for review", and a plain message; the
  Requests tab lists exactly the three asks by source and Overview shows 3.
  Mutation record: `.sp5-orch/d1-mutations.md` (orchestrator).
- `lib/reviews/request-reminder.test.ts` (reminders off: byte-identical; on:
  the tracked link, the plan, scheduling and its failure),
  `lib/reviews/reminder-run.test.ts` (every stop condition, redelivery and
  concurrency), `app/rr/[token]/route.test.ts`, `app/api/cron/review-reminder/route.test.ts`,
  `app/api/sub-accounts/[id]/google-review/route.reminder.test.ts`,
  `components/settings/review-reminder-card.test.ts`.
- `e2e/specs/reputation-reminders.spec.ts` — reminders off (the real body is
  today's), reminders on set through Reputation → Settings (tracked body, a
  signed reminder POST sends the second SMS, a redelivery sends nothing, the
  /rr/ click 302s and stamps clickedAt, the next reminder stops: clicked), an
  opted-out contact stops, retries run out. Mutation record:
  `.sp5-orch/d2-mutations.md`.
