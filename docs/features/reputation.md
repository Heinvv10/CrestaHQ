# Reputation

A sub-account's **Reputation** area (sidebar → Reputation, `/sa/[id]/reputation`)
is a reporting layer over data LeadStack already owns: the synced Google review
cache ([gbp-reviews.md](gbp-reviews.md)) and the review-request dispatcher
(`lib/reviews/request.ts`). It adds no new way to talk to Google or to customers.
Ledger and build order: [docs/parity/sp5.md](../parity/sp5.md).

Tabs today: **Overview** · **Reviews** · **Widgets** (SP5 PR a). Later SP5 PRs add
Requests, Insights and Settings.

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
| Requests sent | Rows in `subAccounts/{id}/reviewRequests` (below) with `sentAt` in range, by channel. **Only the dispatcher's sends are logged** — Request review (the contact profile's button), quote paid, deal completed. Review asks sent any other way are **not counted yet** (SP5 PR d) — a review link pasted into a workflow SMS / WhatsApp / email step body, a WhatsApp template's variable or button (e.g. the `review_request` starter), a link pasted into a broadcast email, and the Conversations composer's "Ask for review" (or a typed link); the tile and card say so. (`{{reviewUrl}}` does not resolve in workflow or broadcast merge tags — it renders "" — so those asks carry a pasted link or an approved template.) `countingSince` = the **first logged request** (not the deploy date — a sub-account that sends nothing for a while starts later); requests before it were not logged and are not backfilled. The previous-period count is given only when the first logged request is no later than the previous period's start. At most 2,000 rows per request (`truncated.requests`). |
| Requests vs reviews | Shown **side by side per bucket, never attributed**: Google gives no link between a request and a review. |
| Health | `health` is the reviews inbox's `deriveHealth` result (via `publicSummary`), so both pages show the same stale / partial / reconnect / sync-pending / error / never-synced state and banner. |

### Checklist

Booleans from real state only, recomputed on every request — no stored progress:
Google connected (and not flagged reconnect-required), a listing selected, a
review link configured (`resolveReviewUrl(sub).configured`), a widget exists
(`gbpWidgetMeta.publicId`), and at least one review request logged.

## The review-request log

`subAccounts/{id}/reviewRequests/{auto}` — written by `maybeSendReviewRequest`
after every **successful** send it makes: its three callers are the manual
Request review route (`/api/comms/review-request/send`), quote paid
(`lib/server/quotes-service.ts`) and deal completed (`/api/deals/[id]`). Review asks
sent any other way do NOT write it yet — a review link pasted into a workflow SMS / WhatsApp / email step body, a WhatsApp template's variable or button (e.g. the `review_request` starter), a link pasted into a broadcast email, and the Conversations composer's "Ask for review" (or a typed link) (workflow steps:
`lib/workflows/engine.ts`; composer: `components/conversations/use-merge-tag-composer.tsx`).
Logging those is SP5 PR (d). Row fields: `{agencyId, subAccountId, createdByUid, contactId, channel, trigger,
status: "sent", messageSid, sentAt, clickedAt: null, feedbackAt: null}`.
`createdByUid` is the signed-in sender of a manual send, else the label
`"review-request"`; `channel` is the normalized one (`sms` / `whatsapp_template` /
`whatsapp_manual`). Refusals and failed sends write nothing. A failed log write
is logged by kind (`[reviews/request] reviewRequests log write failed kind=…`)
and never fails the send. What is sent, to whom and when is unchanged —
`lib/reviews/request-log.test.ts` pins the SMS and WhatsApp bodies and the
activity row byte for byte. Server only: no client rule (default deny), no index.
`clickedAt` / `feedbackAt` are reserved for the Requests tab (SP5 PR d); nothing
writes them yet.

## Tests

- `lib/reputation/overview.test.ts` — every definition above.
- `app/api/sub-accounts/[id]/reputation/overview/route.test.ts` — real
  require-tenancy, real sync over the fake provider, in-memory Firestore:
  non-member / other-sub-account 403, invalid range 400, numbers over the synced
  reviews, tombstoned / other-listing / past-retention excluded, another
  sub-account's log never counted, gate-off / not-connected / no-listing,
  checklist.
- `lib/reviews/request-log.test.ts`, `app/api/comms/review-request/send/route.test.ts`
  — the log row, the actor, and the unchanged send.
- `components/reputation/*.test.ts` — every UI state (jsdom).
- `e2e/specs/reputation-overview.spec.ts` — sync the fake's reviews, two real
  manual sends through the fenced fake SMS rail, the tiles equal the numbers
  computed from that data; the sidebar entry; the gate-off state on the secondary
  fixture. Mutation record: `.sp5-orch/a-mutations.md` (orchestrator).
