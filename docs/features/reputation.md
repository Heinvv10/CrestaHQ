# Reputation

A sub-account's **Reputation** area (sidebar → Reputation, `/sa/[id]/reputation`)
is a reporting layer over data LeadStack already owns: the synced Google review
cache ([gbp-reviews.md](gbp-reviews.md)) and the review-request log every
sender writes (below). It adds no new way to talk to Google or to customers.
Ledger and build order: [docs/parity/sp5.md](../parity/sp5.md).

Tabs today: **Overview** · **Reviews** · **Requests** · **Widgets** (SP5 PRs a, d1).
Later SP5 PRs add Insights and Settings.

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
sub-account** (else null, shown as "Deleted contact"). Never a message body,
phone number or email address. The **search** matches contact names over the
rows already loaded, and the page says so.

**Send Review Request** (Overview and Requests headers) opens a dialog with the
shared contact picker (`components/quotes/contact-picker.tsx`, this
sub-account's contacts, territory-filtered like every contact list), then POSTs
the existing manual route `/api/comms/review-request/send` — the dispatcher,
`trigger: "manual"`, which skips the cooldown as it always has. Its answer is
shown inline in plain words (`components/reputation/send-result.ts`: e.g.
`not_configured` → "Set your review link first …"); a successful send reloads
the page's data.

Statuses are what LeadStack can observe truthfully: **sent** and **failed**.
Delivered / read are not wired to the log; clicked / feedback (`clickedAt`,
`feedbackAt`) and reminders are later SP5 work (ledger Q1/Q3) — nothing writes
them yet.

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
provider. A scheduled send that throws is not logged: nothing says whether a
provider was reached.

**What makes a message a review ask** (`isReviewAsk`, `lib/reviews/review-ask.ts`):
any rendered part — body, email subject, a WhatsApp template's filled body or a
URL button — contains the sub-account's **configured** review URL
(`resolveReviewUrl(sub).configured`), or the WhatsApp template is the gallery's
`review_request` starter (its name or its unedited body). Detection is on the
rendered text because `{{reviewUrl}}` does not resolve in workflow or broadcast
merge tags (it renders ""), so those asks carry a pasted link. The composer's
"Ask for review" inserts the link into a normal message, so the URL check
covers it. A `send_whatsapp` step is judged on what the window made it send:
its text, or its template. Not covered: Messenger / Instagram messages, missed-call
text-back, AI replies and booking messages — none is a review-request channel.

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
