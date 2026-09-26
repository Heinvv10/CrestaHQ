# Review auto-reply v1

> Status: **PLAN 2026-09-26, rev 5 (2026-09-26, PR 2 review)** — rev 4 after three adversarial reviews; PR 1 merged, PR 2 in review (#287).
> **Rev 5 (2026-09-26, PR 2 review)** folds in the PR 2 team review's rulings: a review that has or ever had a
> reply is never auto-posted to (sticky `hadReply` + a durable `autoReplyNever/{stableReviewKey}` marker outside the
> cache); markers and Discards are keyed by an ACCOUNT-INDEPENDENT `stableReviewKey` = sha256 of
> `locations/{loc}/reviews/{id}` (the `accounts/{a}/` prefix stripped), because the same location selected through
> another Google account renames its reviews (new cache doc ids); re-selecting the same location through another
> account is a listing change; no reviewer name on the auto path; an already-accepted post is only finalized; `requireNoReply` takes
> the textHash and can answer `not_queued`; `listing_shared` refuses/pauses; a `post_failed` state; any listing
> change or clear switches auto-reply off. The sections below are updated to match.
> Owner rulings locked in a grill
> session with Hein on 2026-09-26. This plan **reverses** the SP5 (c) guarantee
> in [docs/features/reputation.md](docs/features/reputation.md#ai-reply-drafts-sp5-c)
> ("nothing posts a reply to Google except the admin's click") for sub-accounts
> that opt in; that doc (and every other "nothing posts" invariant) is rewritten
in PR 2, the PR that makes it false.

## Goal

A sub-account admin can let LeadStack reply to Google reviews on its own, the
way GHL's review auto-responder does: per star rating, choose **Auto** (the AI
drafts and posts) or **Approval** (the AI drafts and a person posts). Nothing
changes for a sub-account that has not switched it on.

## Owner rulings (2026-09-26)

1. **Per-star modes are editable in the UI.** Each of 1★–5★ is `auto` or
   `approval`. Default when first enabled: 4★ and 5★ `auto`, 1★–3★ `approval`.
2. **Texted reviews always go to approval in v1** (rev 2 — was a default-on
   checkbox). A 4★/5★ review with written text is held even if its star is
   `auto`; only rating-only reviews (blank or whitespace comment — most of
   Velocity's volume) post automatically. Reason: a 5★ review can carry a
   question or complaint, and the draft prompt's refund/insult/tone limits are
   prompt-only, "acceptable because a human reads every draft"
   (`reputation.md:527-532`). Untrusted review text therefore never reaches an
   unattended post. Unlocking texted auto-posts is a v2 decision with its own
   output checks.
3. **Held reviews live on the Reviews tab** under a **"Needs approval"**
   filter, with the AI draft pre-filled in the reply composer — not in
   Conversations.
4. **Backlog is an option, default off.** Off: only reviews whose
   `createTime` is at or after `enabledAt` are eligible. On: older unreplied
   reviews are eligible too, drip-fed newest first within the daily cap and
   subject to the same per-star rules.
5. **Daily cap: 20 auto-posts per sub-account per SAST day**, plus an
   auto-draft budget of **40 of the 100 daily drafts** so humans' "Draft with
   AI" is never starved. Over either = held without a draft — over the 20
   posts `reason: "cap"`, over a draft limit `reason: "no_budget"` (rev 5,
   matching the code); backlog is simply left for the next day. A failed post is not
   refunded.
6. **Google OAuth client is published** ("In production", unverified,
   2026-09-26). `business.manage` is a sensitive scope, so Google verification
   is still required and is submitted separately; until then the consent
   screen shows the unverified-app warning and a 100-user lifetime cap applies.

## What already exists (verified 2026-09-26)

- **Drafts** — `lib/reputation/draft.ts` (`draftInputFor`) +
  `lib/reputation/ai/openrouter-draft.ts`: star, comment, reviewer first name,
  business name, `reviewsAiConfig.replyGuidelines`; untrusted-text system
  prompt; `unsuppliedContact` refuses any phone/email/URL not in the
  guidelines. Caps: `DRAFT_DAILY_CAP=100`/day inside the shared
  `DAILY_AI_CALL_CAP=300`/day (`sentiment-calls.ts`), transactional
  `beginDraftCall`.
- **Posting** — `lib/gbp/reply.ts` `postReply(subAccountId, target, body,
  actorUid)`, the only caller of `putReply`; idempotency ledger
  `gbpReplyAttempts/{sha256(key)[:40]}` + per-review in-flight lock
  (`reply-attempts.ts`); audit `gbpEvents` `reply_posted`. The human
  requirement is enforced only by the route (`requireSubAccountAdmin`).
- **Post-sync hook** — `app/api/cron/gbp-sync/route.ts` collects per-tenant
  runs via `onRun` and runs sentiment in `after()` (`classifyAfterResponse`)
  under a shared deadline. Manual "Sync now" is `POST …/gbp/sync`.
- **Gates** — `reviewsAiEnabledByAgency` (drafts + sentiment) requires
  `googleEnabledByAgency`; the 5-step gate pattern is in
  [docs/architecture/feature-gates.md](docs/architecture/feature-gates.md).
- **Scheduled sync is off in prod** (`GBP_SYNC_SCHEDULE_ENABLED` unset), so
  auto-reply runs only on "Sync now" until Hein sets it.

## Design

### Settings — `subAccounts/{id}.reviewsAutoReply`

```ts
{
  enabled: boolean;
  modes: { 1: "auto" | "approval"; 2: …; 3: …; 4: …; 5: … };
  includeBacklog: boolean;    // default false
  enabledAt: Timestamp | null; // set on every off→on transition
  enabledByUid: string | null;
  listingLocationName: string | null; // the listing it was enabled for
  updatedAt: Timestamp; updatedByUid: string;
}
```

`GET/PUT /api/sub-accounts/[id]/reputation/auto-reply` — GET any member, PUT
sub-account admin. Body allow-list `{enabled, modes, includeBacklog}` (unknown
keys 400, every star 1–5 present); the server stamps `enabledAt`,
`enabledByUid` and `listingLocationName` on the off→on transition, computed
in a transaction. Turning it **on** needs the agency gate (403 otherwise), a
selected listing (409 `no_listing`) that no other sub-account has also
selected (409 `listing_shared`, rev 5 — the engine cannot see replies cached
under another sub-account); turning it **off** is always allowed. **Any
listing change or clear** (select another, DELETE, disconnect,
`not_accessible_after_reconnect`) sets `enabled: false`, modes kept (rev 5):
resuming needs an explicit re-enable. The existing
`ai-settings` route keeps refusing an `autoReply` key — auto-reply has its own
route so that guarantee's test stays meaningful for the guidelines route.

### Agency gate — `reviewsAutoReplyEnabledByAgency`

Default `false`; **kept out of `PLAN_GATE_KEYS`** (`types/billing.ts`) like
Payments and Google, so no billing plan can switch public posting on for its
clients. Effective only with `reviewsAiEnabledByAgency` **and**
`googleEnabledByAgency`. Full 5-step wiring (schema → creation defaults →
PATCH branch → runtime 403 → manage-dialog checkbox → `FEATURE_GATES` entry),
plus `GATE_FIELDS` in `lib/audit/record.ts`, plus a manage-dialog test that
reopening shows the saved value. The `FEATURE_GATES` entry carries `assistantMayEnable: false`, checked in
`set_feature_gate`'s validate (`lib/ai-suite/capabilities/agency.ts`), so the
Workspace Assistant and Agent API keys can disable the gate but never enable
it. Turning the gate off
stops posting **within the current run** (re-checked before every post); it
does not delete settings or pending drafts.

### Kill switch

Env `REVIEWS_AUTO_REPLY_ENABLED` — unset = the engine never runs anywhere on
this deployment. Merging PR 2 is inert until it is set; unsetting it is the
incident stop — it needs a restart of both blue/green colours, so it is a
minutes-scale stop, not instant (RUNBOOK note in PR 5). PR 2 is not deployed with it set before PR 3 ships (held drafts
would be invisible).

### Engine — `lib/reputation/auto-reply/`

- `decide.ts` — pure: `(review, settings, now, counts) →
  "skip" | "hold" | "auto"`. Skip: reply present or pending in cache, **the
  review has ever had a reply (`hadReply`) or has an `autoReplyNever` marker**
  (rev 5), already auto-replied, tombstoned, not `settings.listingLocationName`, not seen by the run that just
  finished (`lastSeenAt >= runStartedAt` — stale cache never posts),
  before `enabledAt` with backlog off (a still-queued draft of such a review is
  converted to `approval`, text kept — 4b, rev 5). Hold: mode `approval`, any
  written text, over a cap. Auto otherwise.
- `run.ts` — `autoReplyAfterSync(subAccountId, runStartedAt, deadline)`:
  0. "Seen this run" means `lastSeenAt >= runStartedAt`, passed through
     `onRun` (a `passId` spans several runs, so it is not used).
  1. Take an `autoReplyLease` per sub-account (sentiment-lease pattern) — a
     second concurrent run exits.
  2. Re-read kill switch, gates, settings; list eligible reviews newest first.
  3. Per review: check the deadline; reserve the auto-draft share **inside
     `beginDraftCall`'s transaction on its UTC `draftsDay`** (one day boundary,
     one transaction, no race with human drafts); draft via the existing
     pipeline (same contact guard; **rev 5: no reviewer name at all on the
     auto path** — a display name is untrusted text; "Draft with AI" keeps it). **Store the draft on the review first** as `pendingReply
     {text, textHash, basisHash, reason, at, model}` so a retry reuses the
     exact bytes (no redraft, no `reused` dead end).
  4. For `auto`: check the deadline; an attempt Google already accepted
     (ledger `succeeded`) is only finalized — `pendingReply` cleared,
     `autoReplied` + `hadReply` + `autoReplyNever` written, no call, no count,
     no audit (rev 5); `loadReplyTarget` + `replyPreflight` again; then one
     transaction that re-checks kill switch, all three gates, `enabled`,
     `modes[star]`, `enabledAt`, listing — **pausing while another sub-account
     has selected the same location (`listing_shared`, rev 5)** — review
     `basisHash`, no reply ever (`reply`, `hadReply`, `autoReplyNever`),
     **`pendingReply.reason` `auto_queued` (or `post_failed`) with the same
     `textHash`** (a Discard clicked mid-run wins), and counts the post against the 20/day (SAST day). Then
     `postReply` with idempotency key `auto:{reviewDocId}:{textHash}` and
     **`requireNoReply({textHash})`** (below); `postReply` maps
     `already_replied` / `not_queued` to a skip (`already_replied` clears
     `pendingReply`). A post Google accepted but not recorded locally is
     finalized as above and audited once. A refusal about this review (Google
     404 / other 4xx) → `post_failed` and the run continues; auth, 429,
     5xx/network and the deadline stop the run (rev 5).
  4b. A failed step-4 re-check sets the resulting state: mode switched to
     Approval → `reason: "approval"`, text kept (now waits for a human); gate
     off, kill switch unset or auto-reply disabled → row kept as
     `auto_queued`, shown as "Auto-post paused"; `enabledAt` re-check failed
     (auto-reply switched off and on, backlog off) → `reason: "approval"`, text
     kept. A paused `auto_queued` draft may post long after it was written when
     auto-reply resumes — intended: the `basisHash` check guarantees the review
     itself has not changed.
  5. A refused/failed draft → `pendingReply {reason: "draft_failed"}` with no
     text; the next run retries the draft once per day.
- **`pendingReply` state table** — engine behaviour per stored state
  (fresh = `basisHash` equals the review's current hash):

  | `pendingReply.reason` | fresh | stale |
  |---|---|---|
  | none | decide from scratch | — |
  | `auto_queued` (stored, post not yet succeeded) | post the stored bytes; no new draft | drop bytes, re-decide + re-draft |
  | `approval` / `texted` (held) | skip — waits for a human | re-draft, stays held (reason re-derived, rev 5) |
  | `draft_failed` | retry the draft once `at` is ≥24 h old | re-decide |
  | `post_failed` (rev 5: Google refused this review's post; text kept, shown held) | retry the stored bytes once `at` is ≥24 h old | re-decide |
  | `no_budget` / `cap` | re-decide next day (may then auto-post if still eligible) | re-decide |
  | `dismissed` (Discard) | skip for good | re-decide (the review changed) |

  Discards also survive a cache clear (`clearGbpCache` deletes review docs
  when the Google gate is toggled, `feature-gates-service.ts:139-147`): Discard
  additionally writes `subAccounts/{id}/autoReplyDismissed/{stableReviewKey}
  {basisHash, at, byUid, reviewDocId}` (rev 5: keyed account-independently,
  so it also survives an account switch) — an id and a hash, no Google content — which
  `decide` treats as `dismissed` when the hash matches. It carries
  `agencyId`/`subAccountId`/`createdByUid`, is server-only (no client rule),
  is listed in `docs/architecture/firestore-collections.md` in PR 2, and
  deliberately outlives review retention — it holds only a review id and a
  hash, no Google content.

  Every row has a `run.test`, including discard → rerun → no draft, no post.
  Rev 5: the claim can also answer `not_queued` (the stored draft is no longer
  these queued bytes, or the star is no longer Auto) — a skip, nothing written.
  Likewise `subAccounts/{id}/autoReplyNever/{stableReviewKey} {agencyId,
  subAccountId, createdByUid, at, reason: "replied" | "auto_replied",
  reviewDocId}` —
  written by the sync (first sight of a reply, current or cached), every posted
  reply and a finalized auto post; never deleted, outside the cache, an id
  only; `decide`, the step-4 transaction and the claim all refuse a review
  that has one.
- **`requireNoReply`** — a new option on `claimAttempt` (auto path only):
  inside the transaction, return `already_replied` when the review **has or
  ever had** a reply (`reply`, `hadReply`, `autoReplyNever` — rev 5), and
  `not_queued` unless `pendingReply` is still the queued `textHash` passed in
  and `modes[star]` is still `auto`. Today `claimAttempt` short-circuits only on a byte-equal reply
  (`reply-attempts.ts:92-94`) and otherwise posts over it, so without this an
  auto-post could overwrite a human's reply. Mutation-tested. Residual risk,
  stated: a reply made at Google (or by GHL) after this run's fetch is still
  invisible; the window is the run's own duration, and step 1 of `decide`
  (seen-this-run) bounds it.
- **Ordering in `after()`**: auto-reply for all synced tenants first (bounded
  by the caps), then sentiment, so a large sentiment catch-up cannot starve
  later tenants' replies. Wired into the cron route and manual "Sync now";
  never inside the sync itself.
- **Held-draft freshness**: `pendingReply.basisHash` ≠ the review's current
  hash → stale: not served, not pre-filled, re-drafted next run. The sync
  clears `pendingReply` when a reply appears (any source). **Discard** writes
  `pendingReply {reason: "dismissed", basisHash}` rather than deleting, so the
  engine never re-drafts or auto-posts that review unless its content changes.
- **Success path**: `recordReplyChange` clears `pendingReply`, sets the sticky
  `hadReply` and writes the `autoReplyNever` marker (reason `replied`, or
  `auto_replied` for an auto post) — rev 5 — and, for auto posts, writes
  `autoReplied {at, key}`; the sync's merge preserves them. It
  drives the "Auto-replied" tag and the edited-to-≤3★ alert.
- **Retention**: `pendingReply` lives on the review doc, so it is purged with
  the review (30 days *unseen*, per the existing retention rule).
- **Audit**: `gbpEvents reply_posted` with `actorUid: "system:auto-reply"`
  (precedent: `"system:mailbox"`) and `createdByUid: enabledByUid`; nothing
  reads `gbpEvents` today. Also `recordAuditEvent` with
  `actor {type: "system"}` per `docs/architecture/audit-events.md`.
- Usage docs: `subAccounts/{id}/private/autoReplyUsage {day (SAST), posts}` —
  posts only; auto drafts are counted as `autoDraftCalls` in
  `private/sentimentUsage` on its UTC `draftsDay`, inside `beginDraftCall`'s
  transaction (rev 5, matching the code). Server-only; no client rules or indexes.

### UI

- Reputation settings: an "Auto-reply" card — master switch, five star rows
  with Auto / Approval, the backlog checkbox, a note that reviews with written
  text always wait for approval, the caps shown read-only. Locked state when
  any of the three agency gates is off, naming the gate. Shown since PR 3
  (PR 1's route refused `enabled: true` with 409 `not_available`; PR 2
  lifted it); it also says when the deployment's kill switch is unset
  (GET `running`, a boolean). **Any listing
  change or clear switches auto-reply OFF** (`enabled: false`, modes kept —
  rev 5; the same location through another Google account counts): the card
  shows it as off with a note that the listing changed — re-enable to resume —
  (PR 3: `reviewsAutoReply.disabledReason: "listing_changed"`, written by the
  listing writers when it was on, cleared by any admin switch) and one alert
  is sent (PR 4).
- Reviews tab: "Needs approval" filter (`pendingReply` present, fresh,
  `reason !== "dismissed"`, and `reply == null`) with a count, over the same capped 500 served records; each row shows its reason
  (held for approval, queued to auto-post, auto-post paused, draft failed,
  over today's limit, post failed — only the reason and draft text are
  served);
  the composer opens pre-filled with the draft; **Post** uses the existing
  human reply route; **Discard** (`POST …/gbp/reviews/[reviewDocId]/auto-reply/dismiss`,
  guarded like the reply route) marks it dismissed (see the state table) and
  removes it from the filter — E2E asserts the count drops and the row is gone. Auto-posted replies
  show a small "Auto-replied" tag.

### Alerts

- A sync that holds ≥1 review → one push/email per sync run, through the
  existing notification rail (the one WhatsApp alerts use).
- `googleConnectionMeta.reconnectRequired` flipping false→true → one alert
  (flip detected inside `markReconnectRequiredIf`, `lib/gbp/tokens.ts:42`), so
  a stalled auto-reply is never silent.
- An auto-replied review later edited to ≤3★ → one alert.
- Auto-reply switched off by a listing change (another listing, the same
  location through another Google account, a clear, a disconnect or a
  reconnect that drops the listing — rev 5) → one alert, matching the card's
  "switched off: the listing changed — re-enable to resume" note (PR 4).

## PR DAG

| PR | Scope | Depends on | Merge gate |
|---|---|---|---|
| 0 | *(owner step, no code)* one manual reply posted live from LeadStack and seen on Google — the first real write | — | Hein approves the reply text |
| 1 | Agency gate + settings schema + `auto-reply` route + settings card (hidden) | — | green CI + blind review (Level 3) |
| 2 | Kill switch, `requireNoReply`, `decide.ts` + `run.ts` + lease + `pendingReply` + post-sync wiring; rewrite the now-false invariants in the same PR (`reputation.md` guarantee + "no draft text is stored", `reply.ts:16-21`, `draft.ts:12`, `firestore-collections.md`) | 0, 1 | green CI + blind review **+ adversarial breaker** + **Hein approves the merge** (posts publicly without a click) |
| 3 | Reviews tab "Needs approval" filter, pre-filled composer, Discard, "Auto-replied" tag | 2 | green CI + blind review |
| 4 | Held, reconnect-required, edited-to-≤3★ and listing-change (auto-reply switched off) alerts | 2 | green CI + blind review |
| 5 | Feature-gates + env docs, parity ledger; live proof | 3, 4 | green CI + blind review |

## Validation

- `decide.test.ts`: the full matrix — star × mode × texted/blank ×
  before/after `enabledAt` × backlog × caps × replied/pending/tombstone ×
  seen-this-run × listing match. Each guard mutation-tested (invert it → a
  named test goes red).
- `run.test.ts` with the fake provider: `auto` calls `putReply` exactly once;
  a second run calls it zero times; **a human reply landing during the draft
  call → no post** (`requireNoReply`); a failed post then a rerun → posts the
  stored bytes once; two concurrent runs → one draft, one post; gate, mode,
  kill switch or listing changed mid-run → nothing posts; edited review with a
  held draft → stale, re-drafted; stale-cache review with backlog on → skipped;
  auto-draft budget 40 → 41st held without a draft; deadline cut-off between
  draft and post → no post, draft kept.
- Route tests for the settings route (member GET, admin PUT, gate-off 403,
  strict body).
- E2E (fake provider): enable, Sync now → rating-only 5★ auto-replied, 3★ and
  texted 5★ in "Needs approval"; approve one from the filter; rerun → no new
  posts.
- Live, after PR 5 deploys: enable on Velocity (#1002) with backlog off; the
  first new 4★/5★ rating-only review is auto-replied and visible on Google.

## Explicitly not in v1

Auto-posting reviews that have written text;
auto-reply for any source but Google; per-listing settings when a sub-account
has several listings (settings apply to the current listing); editing or
deleting replies automatically; templates without AI; sentiment-based routing
(star rating + text presence only).

## Owner steps (Hein)

0. Approve one of the drafted Velocity replies so PR 0 (first live write) can happen.
1. Reconnect Google on Velocity (#1002) and CrestaHQ (#1000) — the current
   tokens were issued while the client was in Testing.
2. Submit Google verification (logo at `~/Downloads/crestahq-oauth-logo-120.png`,
   scope justification + demo video — Claude can draft both).
3. Set `GBP_SYNC_SCHEDULE_ENABLED=1` in the prod env when ready for scheduled runs.
4. Approve PR 2's merge; approve each production deploy.
