# Review auto-reply v1

> Status: **PLAN 2026-09-26** (nothing built). Owner rulings locked in a grill
> session with Hein on 2026-09-26. This plan **reverses** the SP5 (c) guarantee
> in [docs/features/reputation.md](docs/features/reputation.md#ai-reply-drafts-sp5-c)
> ("nothing posts a reply to Google except the admin's click") for sub-accounts
> that opt in; that doc is rewritten in PR 5, not before.

## Goal

A sub-account admin can let LeadStack reply to Google reviews on its own, the
way GHL's review auto-responder does: per star rating, choose **Auto** (the AI
drafts and posts) or **Approval** (the AI drafts and a person posts). Nothing
changes for a sub-account that has not switched it on.

## Owner rulings (2026-09-26)

1. **Per-star modes are editable in the UI.** Each of 1★–5★ is `auto` or
   `approval`. Default when first enabled: 4★ and 5★ `auto`, 1★–3★ `approval`.
2. **Hold texted reviews** — one checkbox, default **on**: a 4★/5★ review with
   written text goes to approval even if its star is `auto`. Rating-only
   reviews (most of Velocity's volume) still post automatically. Reason: a
   5★ review can carry a question or complaint ("fast, but I wish I could add
   more than 5 people") that needs a considered answer.
3. **Held reviews live on the Reviews tab** under a **"Needs approval"**
   filter, with the AI draft pre-filled in the reply composer — not in
   Conversations.
4. **Backlog is an option, default off.** Off: only reviews whose
   `createTime` is at or after `enabledAt` are eligible. On: older unreplied
   reviews are eligible too, drip-fed newest first within the daily cap and
   subject to the same per-star rules.
5. **Daily cap: 20 auto-posts per sub-account per day.** Over the cap = held
   (backlog: simply left for the next day).
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
  holdTexted: boolean;        // default true
  includeBacklog: boolean;    // default false
  enabledAt: Timestamp | null; // set on every off→on transition
  enabledByUid: string | null;
  updatedAt: Timestamp; updatedByUid: string;
}
```

`GET/PUT /api/sub-accounts/[id]/reputation/auto-reply` — GET any member, PUT
sub-account admin; PUT refused 403 unless the agency gate is on; body
validated strictly (unknown keys 400, every star 1–5 present). The existing
`ai-settings` route keeps refusing an `autoReply` key — auto-reply has its own
route so that guarantee's test stays meaningful for the guidelines route.

### Agency gate — `reviewsAutoReplyEnabledByAgency`

Default `false`, not pre-ticked in plans; effective only with
`reviewsAiEnabledByAgency` **and** `googleEnabledByAgency`. Full 5-step wiring
(schema → creation defaults → PATCH branch → runtime 403 → manage-dialog
checkbox → `FEATURE_GATES` entry). Turning the gate off stops posting on the
next run; it does not delete settings or pending drafts.

### Engine — `lib/reputation/auto-reply/`

- `decide.ts` — pure: `(review, settings, now, postedToday) →
  "skip" | "hold" | "auto"`. Skip: already replied, reply pending, tombstoned,
  not the current listing, before `enabledAt` with backlog off. Hold: mode
  `approval`, texted + `holdTexted`, cap reached. Auto otherwise.
- `run.ts` — `autoReplyAfterSync(subAccountId, deadline)`: re-reads gates +
  settings, lists eligible reviews newest first, and for each: draft via the
  existing draft pipeline (same caps, same contact guard); `auto` → `postReply`
  with idempotency key `auto:{reviewDocId}:{contentHash}` and actor
  `system:auto-reply` (audit event also records `enabledByUid`); `hold` → write
  `pendingReply {text, reason, at, model}` on the review doc. A refused or
  failed draft → `pendingReply` with `reason: "draft_failed"` and no text. Stops
  on the deadline or the first provider failure (like sentiment).
- Wired into the cron route's `after()` next to sentiment and into manual
  "Sync now". Never inside the sync itself.
- `pendingReply` is removed when a reply posts (any path) or on Discard, and is
  purged with the review under the existing 30-day retention.
- Daily count: `subAccounts/{id}/private/autoReplyUsage` (date-keyed), counted
  transactionally before the post.

### UI

- Reputation settings: an "Auto-reply" card — master switch, five star rows
  with Auto / Approval, the two checkboxes, the daily cap shown read-only.
  Locked state when the agency gate is off.
- Reviews tab: "Needs approval" filter (`pendingReply` present) with a count;
  the composer opens pre-filled with the draft; **Post** uses the existing
  human reply route; **Discard** clears `pendingReply`. Auto-posted replies
  show a small "Auto-replied" tag.

### Alerts

- A sync that holds ≥1 review → one push/email per sync run, through the
  existing notification rail (the one WhatsApp alerts use).
- `googleConnectionMeta.reconnectRequired` flipping to true → one alert, so a
  stalled auto-reply is never silent.

## PR DAG

| PR | Scope | Depends on | Merge gate |
|---|---|---|---|
| 1 | Agency gate + settings schema + `auto-reply` route + settings card | — | green CI + blind review (Level 3) |
| 2 | `decide.ts` + `run.ts` + `pendingReply` + post-sync wiring | 1 | green CI + blind review **+ adversarial breaker** + **Hein approves the merge** (posts publicly without a click) |
| 3 | Reviews tab "Needs approval" filter, pre-filled composer, Discard, "Auto-replied" tag | 2 | green CI + blind review |
| 4 | Held + reconnect-required alerts | 2 | green CI + blind review |
| 5 | Rewrite `reputation.md` guarantee, feature-gates doc, env doc; live proof | 3, 4 | green CI + blind review |

## Validation

- `decide.test.ts`: the full matrix — star × mode × texted × holdTexted ×
  before/after `enabledAt` × backlog × cap × already-replied/pending/tombstone.
  Each guard mutation-tested (invert it → a named test goes red).
- `run.test.ts` with the fake provider: `auto` calls `putReply` exactly once;
  a second run calls it zero times (idempotency); gate off mid-run → nothing
  posts; draft refusal → held, no post; cap 20 → 21st held.
- Route tests for the settings route (member GET, admin PUT, gate-off 403,
  strict body).
- E2E (fake provider): enable, Sync now → rating-only 5★ auto-replied, 3★ and
  texted 5★ in "Needs approval"; approve one from the filter; rerun → no new
  posts.
- Live, after PR 5 deploys: enable on Velocity (#1002) with backlog off; the
  first new 4★/5★ rating-only review is auto-replied and visible on Google.

## Explicitly not in v1

Auto-reply for any source but Google; per-listing settings when a sub-account
has several listings (settings apply to the current listing); editing or
deleting replies automatically; templates without AI; sentiment-based routing
(star rating + text presence only).

## Owner steps (Hein)

1. Reconnect Google on Velocity (#1002) and CrestaHQ (#1000) — the current
   tokens were issued while the client was in Testing.
2. Submit Google verification (logo at `~/Downloads/crestahq-oauth-logo-120.png`,
   scope justification + demo video — Claude can draft both).
3. Set `GBP_SYNC_SCHEDULE_ENABLED=1` in the prod env when ready for scheduled runs.
4. Approve PR 2's merge; approve each production deploy.
