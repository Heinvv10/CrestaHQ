# Usage Metering v1 — Plan (meter + caps + visibility)

Status: BUILT 2026-08-15 (per the locked scope below; not runtime-verified).
One deviation: owner alerts are EMAIL-ONLY — the push pipeline broadcasts
to workspace members, which is the wrong audience for a quota alert; an
owner-targeted push helper is a v2 item.

## Why

Every workspace runs on the agency's shared prepaid resources — one
OpenRouter key (AI replies), one Vapi account (voice minutes), and in
shared mode the agency's Twilio/Resend. Today the wallet balance is the
only ceiling: usage counters exist (`usage/{uid}` email/SMS counts,
per-channel `totalTokensUsed`, per-call `durationSec`) but nothing reads
them, they're keyed per-user where billing needs per-workspace, and
several send paths never record at all.

At twenty clients, one client's heavy month silently starves the other
nineteen, and the agency finds out when a *different* client's agent
stops answering.

**v1 is protection + visibility only.** It produces a trustworthy
per-workspace ledger, enforces per-workspace caps, and shows the numbers.
It moves no money. v2 (monthly overage billed through the existing
one-time-charges rail) and v3 (prepaid wallet with auto-recharge) build
on the same ledger — billing against numbers nobody has watched yet is
how you get disputes, so the meter ships first.

## Non-goals (v1)

- No overage charges, no wallet, no Stripe changes (v2/v3).
- No client-visible usage page (agency-side only; client visibility is a
  v2 decision alongside billing).
- No metering of the agency's own assistant surfaces (Agency Assistant,
  Workspace Assistant, Labs watchdog) — they have their own budget
  controls and aren't client-serving spend. Revisit in v2.
- No hard mid-call cutoff for inbound voice (see Enforcement).

---

## Units metered

| Unit | Field | Source of truth |
|---|---|---|
| Emails sent | `emailsSent` | customer/workspace sends through `sendEmail` (count: 1 per send) |
| SMS segments | `smsSegments` | `countSmsSegments(body)` from `lib/comms/sms-segments.ts` — segments, not messages, because that's what Twilio bills |
| WhatsApp messages | `whatsappMessages` | 1 per send (session + template) |
| AI tokens | `aiTokens` | `callAi()` result `totalTokens`, all customer-facing channels (SMS, WhatsApp, Meta, web chat, voice LLM turns) |
| Voice seconds | `voiceSeconds` | end-of-call `durationSec`, inbound + outbound (stored as seconds; rendered as minutes) |

## Data model

**`subAccounts/{id}/usage/{YYYY-MM}`** — one doc per workspace per
month, increment-only:

```ts
{
  emailsSent: number;        // FieldValue.increment
  smsSegments: number;
  whatsappMessages: number;
  aiTokens: number;
  voiceSeconds: number;
  // Once-per-month notification stamps (see Alerts):
  warnedAt: Partial<Record<UsageUnit, Timestamp>>;   // 80%
  cappedAt: Partial<Record<UsageUnit, Timestamp>>;   // 100%
  updatedAt: Timestamp;
}
```

Decisions:

- **Server-only, read via API.** Rules stay default-deny (no rules
  deploy, no new client-readable surface). The UI reads through
  `GET /api/agency/sub-accounts/[id]/usage` (owner-only). Trade-off
  accepted: the usage view is fetch-on-open, not live — fine for a
  monthly counter.
- **Month docs appear lazily** on first increment; missing doc = zero
  usage. No migration, no cron, no rollover job — the month key does it.
- The legacy per-user `usage/{uid}` counter keeps working untouched
  (it answers "which of my team sends the most", a different question).

## The chokepoint

**`src/lib/server/usage-meter.ts`** — the single write path, same
principle as `smsSendBlock()` / `createTaskServerSide`:

```ts
recordUsage(input: {
  subAccountId: string;
  unit: "emailsSent" | "smsSegments" | "whatsappMessages" | "aiTokens" | "voiceSeconds";
  qty: number;
}): Promise<void>   // best-effort: logs and swallows, NEVER blocks a send
```

Also exports `getEffectiveQuotas(subAccount)` and
`checkQuota(subAccountId, unit, subAccount)` (see Enforcement).

### Call sites (exhaustive)

Metering attaches to the narrowest existing chokepoint per unit:

- **SMS + WhatsApp — one point each.** `sendSmsForSubAccount()` and
  `sendWhatsappForSubAccount()` / template send already take
  `subAccountId` — meter inside `lib/comms/twilio.ts` after a successful
  `messages.create`. Every sender (manual, workflow, AI, MCTB, reviews,
  campaigns) is covered automatically, including future ones.
- **AI tokens — at each orchestrator's completion** (they already
  increment the channel's `totalTokensUsed`, so the counter and the
  meter move together): `ai/respond.ts`, `web-chat/respond.ts`, the
  voice LLM webhook route.
- **Voice seconds — one point.** `end-of-call.ts`, which sees every call
  (inbound + outbound) with its final duration.
- **Email — extend `sendEmail` with an optional `meter?: { subAccountId }`
  param** (there is no id-bearing email chokepoint today). Passed by the
  customer/workspace send sites: manual contact send, workflow
  `send_email` + `notify`, broadcast step, quote send, booking
  confirmation/reschedule/reminder/cancel/mark-paid, review requests,
  AI escalation + capture follow-up. Deployment-level mail (invites,
  billing links, magic links) is deliberately unmetered — it isn't
  client spend.

## Quotas

Two layers, both optional, resolved as
**workspace override → plan quota → unlimited**:

1. **Plan-level** — `PlanDoc.quotas?: UsageQuotas | null` (per-month
   integers per unit; `null`/absent = unlimited). Edited in the plan
   editor alongside the feature-gate bundle; re-applied to subscribed
   workspaces the same way gate edits already are. Voice is configured
   in **minutes** and stored/compared in seconds.
2. **Per-workspace override** — `SubAccountDoc.usageQuotas?: UsageQuotas
   | null`, agency-owner-only PATCH (extends the feature-gates route).
   Covers comped workspaces and special deals; wins over the plan.

Default everywhere = unlimited: **pulling this feature changes nothing
until an owner configures a quota.**

## Enforcement

`checkQuota()` does one month-doc read and compares. **Fail-open**: any
read error means "allowed" — a metering blip must never take down a
client's channels.

Per spend point:

- **SMS/WhatsApp**: checked in `sendSmsForSubAccount` /
  `sendWhatsappForSubAccount` before `messages.create`; over-cap throws
  typed `UsageQuotaExceededError`. Callers already handle typed refusals
  (opt-out pattern): manual routes → 429 with a clear message; workflow
  → `skipped:quota`; AI/MCTB → skip + `ai_skipped`-style activity.
- **AI replies (text channels + web chat)**: pre-flight check in the
  orchestrators next to the existing hours/opt-out guards. Over-cap:
  text channels stay silent with an `ai_skipped` (reason `quota`)
  activity; web chat returns the existing held/offline-style note.
- **Outbound voice**: a `checkQuota` step added to the existing
  compliance gate (`outbound-compliance.ts`) — blocked calls spend zero
  Vapi minutes, consistent with that gate's design.
- **Inbound voice**: v1 does NOT refuse inbound calls (a hard mid-call
  or first-ring cutoff needs Vapi-side control and horrible UX
  trade-offs). Minutes are metered and alerted on; the 100% alert tells
  the owner to act. Revisit hard inbound caps in v2.

## Alerts

At **80%** and **100%** of any unit's effective quota (checked
opportunistically inside `recordUsage`): push + email to the agency
owner ("Acme Plumbing has used 80% of its monthly SMS quota"), stamped
on the month doc (`warnedAt`/`cappedAt`) so each fires **once per unit
per month**. Reuses `sendPushForEvent` + `sendEmail`; no new event
types in the public webhook catalog (internal notification only).

## UI

Agency-side only in v1:

1. **Manage dialog → Usage section** (`SubAccountManageDialog`): current
   month per unit — used / quota / % bar, unlimited shown as "—". Plus a
   3-month mini-history. Data via the owner-only usage GET route.
2. **Plan editor**: quota inputs (blank = unlimited) beside the gate
   checkboxes.
3. **Agency → Client billing table**: a small "over/near quota" badge on
   workspaces past 80% (the list already renders per-workspace status).

## Rollout / ops

- **No Firestore rules or index deploy** (server-only writes, API
  reads, no new queries beyond direct doc gets).
- No cron, no backfill; history starts the month the code ships.
- Counters are increment-only and idempotence is not attempted (a
  retried Twilio send that actually sent twice *should* count twice);
  the one retry-prone writer (end-of-call) is already deduped by callId
  upstream of the meter call.

## Test checklist

- [ ] Manual SMS increments `smsSegments` by the segment count (send a
      200-char GSM message → 2)
- [ ] Workflow email/SMS, broadcast step, booking confirmation, review
      request each move the right counter
- [ ] AI reply on each channel moves `aiTokens`; voice call moves
      `voiceSeconds` once
- [ ] Quota on plan enforces; workspace override wins over plan;
      unset = unlimited
- [ ] Over-cap: manual SMS 429s with a readable error; workflow logs
      `skipped:quota`; AI writes the skip activity; outbound call
      blocked at the compliance gate
- [ ] 80%/100% alerts fire exactly once per unit per month
- [ ] Meter outage (simulated read failure) blocks nothing

## Decisions

1. **Usage is agency-eyes-only in v1** (decided 2026-08-15). The
   workspace sees only enforcement messages; a client-facing usage card
   ships with v2 billing, when the numbers come with something the
   client can do about them. No usage UI mounts in the sub-account
   surface in v1.
2. Shared-mode and dedicated SMS meter identically — the agency only
   *pays* for shared, but caps are about protection either way.

## Open questions (v2, don't block v1)

- Include AI Suite / watchdog tokens in the billable ledger?

## v1.5 — overage rates + dollar accrual (BUILT 2026-08-15)

Sell rates without auto-charging, so the buyer watches real dollar
numbers before v2 bills from them:

- `UsageRates` (integer cents; email/segment/message per item, AI tokens
  per 1,000, voice per minute) on the plan (`rates`) with a per-workspace
  override (`SubAccountDoc.usageRates`) — same resolution as quotas.
  **Sell rates only, owner-typed** — never cost+markup: provider costs
  vary by country/model/account and drift, so a stored cost would
  silently mis-price. Rates are entered in dollars in the plan editor
  beside each unit's Included field.
- `computeOverage()` values usage BEYOND the included quota at the rate;
  no quota = unlimited included = nothing billable; no rate = uncounted.
  Surfaced by the usage GET and shown in the Manage dialog's Usage
  section as "Overage accruing this month: USD X.XX" with a pointer at
  the one-time-charge rail for manual invoicing today.
- Nothing moves money. AI tokens are valued at one blended per-1k rate
  regardless of model (the "credits" model) — per-model pass-through was
  considered and rejected for v2 simplicity.

## v2/v3 preview (not in scope)

- **v2 — overage billing:** monthly cron reads the same `computeOverage`
  numbers and mints a one-time charge (existing `billingCharges` +
  tokenized Stripe checkout rail) automatically. Client-visible usage
  ships here.
- **v3 — prepaid wallet:** per-workspace credit balance, top-up
  checkout, auto-recharge, hard stop at zero (including inbound voice).
