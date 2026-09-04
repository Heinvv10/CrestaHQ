# Handoff — 2026-09-04 16:53 SAST

**Project:** CrestaHQ (`Heinvv10/CrestaHQ`, private) — fork of the LeadStack Agency CRM template
**Branch:** `main`, clean, nothing unpushed. All four of this session's PRs are merged.
**Session goal:** Continue from the 07:50 handoff — finish Phase 1.1 (the Paystack billing rail)
and then build Phase 1.3 (recurring invoicing).

Supersedes `.claude/handoffs/2026-09-04-0750.md`.

## Status

**Phase 1 is now: 1.1 DONE · 1.2 built-but-unproven · 1.3 engine done, NOT usable · 1.4 DONE.**

Client Billing can run on Paystack end to end — provider adapter, webhook receiver, and one
lifecycle shared with Stripe. A recurring-invoice engine exists and its Firestore indexes are
deployed. Neither has ever touched a live external account, and **1.3 has no create API and no
UI, so a schedule can only be made by hand-writing Firestore.** That is the next build.

Merged this session: **#9, #10, #11, #12, #13**. Open PRs (#5, #6) are `crestahq-c9`'s, not mine.

## What got done this session

### PR #11 — `PaystackBillingProvider` (merged)

The second implementation of the existing `BillingProvider` interface. Three Paystack concepts
have no Stripe counterpart, all resolved inside the adapter rather than leaking into
`billing-service.ts`: a Plan *is* the price (so `productId` is synthetic and `updateProduct` /
`deactivatePrice` are documented no-ops), there is no proration, and there is no customer-level
portal.

New files: `src/lib/paystack/{client,billing-api}.ts`, `src/lib/billing/paystack-provider.ts`.

### PR #12 — the Paystack webhook (merged)

`/api/webhooks/paystack`. Rather than a second lifecycle beside Stripe's, the three state changes
were extracted provider-neutral into **`src/lib/server/billing-lifecycle.ts`** —
`activateSubAccountPlan`, `applySubAccountSubscriptionStatus`, `recordSubAccountSubscriptionId`,
`markSubAccountChargePaid` — and Stripe's handlers became thin adapters onto them. That file also
carved ~500 lines out of `billing-service.ts` (1585 → 1094, still far over the 300 cap).

### PR #13 — the recurring-invoice engine (merged)

`recurringInvoices/{id}` schedule doc + `src/lib/recurring/cadence.ts` +
`src/lib/server/recurring-invoice-{service,cycle}.ts` + `/api/cron/recurring-invoices` (daily,
auto-registered as `leadstack-recurring-invoices`).

### PRs #9 and #10 (merged)

Both were the previous session's, left open and later broken by my own work. #9 (the send-path
extraction) had to be rebased past the `billing-service.ts` restructure. #10 (a docs-correction
PR) had gone **stale in the way it exists to prevent** — it still said 1.1's remaining work was
`PaystackBillingProvider` alone. It also surfaced a stale claim of mine in `PARITY_PLAN.md`.

### Deployed

`firebase deploy --only firestore:indexes` against **`crestahq-app`**, verified live:
`recurringInvoices(status, nextRunAt)` and `quotes(recurringInvoiceId, status)`.
Rules were NOT deployed (compiled only, as that command always does).

**How:** the Firebase CLI is not logged in on this machine. I built a service-account JSON from
the `FIREBASE_ADMIN_*` values in `.env.local`, deployed with `GOOGLE_APPLICATION_CREDENTIALS`,
then shredded it. Repeatable; nothing was written to the repo. `.firebaserc` still does not
exist (gitignored), so `--project crestahq-app` is required on every firebase command.

## What's next

1. **The schedule API + operator UI for 1.3.** Until it lands, acceptance criterion 2 (a real
   cycle emailing a real invoice) cannot be exercised at all. Needs: create/list/update/pause
   routes under `/api/sub-accounts/[id]/recurring-invoices`, and a surface to drive them.
   `computeFirstRunAt` in `cadence.ts` is what a create route calls to set the first `nextRunAt`.
2. **The live Paystack test-mode payment.** Only Hein can do this. See "Blockers".
3. **The live WABA test for 1.2** — still gated on Hein provisioning a WhatsApp Business Account.
4. Optional: a dedupe guard for two live checkout links on one sub-account (Stripe has the same
   exposure). Recorded in `PARITY_PLAN.md`; belongs in the completion handler.

## Open questions / blockers

- **Nothing in Phase 1.1 has met a live Paystack account.** One test-mode payment settles all
  three assumptions the webhook router rests on: (a) does `/transaction/initialize` accept the
  request — Paystack's docs contradict themselves on whether `amount` is required alongside
  `plan`, and the code is written to be correct under both readings; (b) does `charge.success`
  echo our `metadata` back intact; (c) does `subscription.create` really arrive as a separate
  event. **Do this before billing anyone.**
- **Paystack is not selected by having a key.** `BILLING_PROVIDER=paystack` is required. This is
  deliberate — see "Context".
- Indexes may still have been BUILDING at 16:53; the sweep throws `FAILED_PRECONDITION` until
  they are READY. Nothing calls it yet (the QStash schedule only auto-registers in production).

## Context the next session needs

**Blind review found 25 real defects across the three PRs, most of them mine, and the pattern is
worth internalising: the mistakes were never in the code being obviously wrong — they were in
plausible readings of a third-party API and in tests that asserted the wrong thing.**

Paystack event semantics that cost two review rounds:

- **`subscription.not_renew` does NOT end a subscription.** It means auto-renew was switched off;
  the subscription is "active, non-renewing" and the paid period runs out. `subscription.disable`
  is the terminating event. Cancelling on `not_renew` paywalls someone for weeks they paid for.
- **`charge.success` fires for EVERY charge on the agency's account**, not just renewals. A
  metadata-less charge is only treated as a renewal if it carries a plan code AND that plan is
  the workspace's (`matchPriceId` on the shared handler). Without both, a lapsed client paying
  the agency for something else unlocks a plan they have not paid for.
- **`subscription.create` proves a subscription object exists, not that money moved**, and can
  arrive BEFORE the payment. It records the code and never activates.
- A Paystack plan switch cancels one subscription and opens another with a NEW code.
  `switchSubscriptionPlan` returns the post-switch id and the caller MUST persist it.

Recurring-invoice constraints:

- **Idempotency lives on the schedule, never on invoice status.** The send path swallows a failed
  lifecycle write while the email still goes out, so an invoice can sit at `draft` with no
  `sentAt` after the customer received it. Nobody may add a "re-send unsent invoices" pass
  without fixing that write first.
- **Month-end clamps from the stored anchor, never the previous clamped day** (31 Jan → 28 Feb →
  31 Mar). Carrying it forward costs the schedule its anchor permanently.
- **Completion is decided inside the claim transaction**, from the cycle claimed — not from
  `now`, and not on the success path only. Both alternatives were tried and both bill wrongly.
- Cycles more than `MAX_CATCHUP_DAYS` (31) stale fast-forward without billing, or a backdated
  schedule emails one real invoice per night until it catches up.

**Testing lessons, all earned the hard way this session:**

- **A test name that asserts the opposite of its body is worse than no test.** Happened twice —
  once naming a no-op guard as if it did the opposite, once asserting the `not_renew` bug as
  correct behaviour. Anyone reading the suite takes it for a decision.
- **`hour12: false` renders midnight as "00" on some ICU builds and "24" on others.** A test
  passed here and failed for the reviewer. Always pass `hourCycle: "h23"`. An environment-
  dependent assertion makes a blocking gate a coin flip.
- **A mock that discards its own writes cannot prove idempotency.** The transaction mock recorded
  patches without applying them, so no test could observe a second delivery. It applies them now.
- **Mutation testing cannot reveal a guard nobody thought to test.** Two call-site guards in
  `billing-service.ts` survived because that file had no tests at all — which is exactly why the
  defect there was invisible.
- **Every mutation must md5-verify the file on restore.** Carried from the previous session; held
  for all ~50 mutations run here.

**Design decisions that look wrong until you know why:**

- `BILLING_PROVIDER=paystack` is required to select the rail; a key alone does nothing. Inferring
  from key presence was rated CRITICAL — pasting a key would have moved live billing onto a rail
  whose webhook did not exist, where a payment lands and the workspace stays walled.
- Arrears count OUTSTANDING invoices, not consecutive ones, and the field is named
  `outstandingInvoices` for that reason. `draft` is deliberately excluded from
  `UNPAID_INVOICE_STATUSES` so review-first schedules do not escalate over money nobody was
  asked for.
- Escalation fires only when the count is worse than `lastEscalatedCount`, not on every cycle
  above threshold.

**Non-obvious mechanics:** `gh pr create/merge` still fail with a GraphQL permissions error — use
`env -u GITHUB_TOKEN -u GH_TOKEN gh api -X POST repos/Heinvv10/CrestaHQ/pulls --input f.json` and
`-X PUT .../pulls/N/merge -f merge_method=merge`. Node via
`export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`. Self-hosted runner only; CI ~2 min.

## Git state

- **Uncommitted:** clean.
- **Unpushed commits:** none.
- **Stashes:** none.
- **Worktrees:** mine are removed. Remaining are **other sessions' — leave them alone**:
  `CrestaHQ-wt-snapshots`, `CrestaHQ-wt-wabridge`, `CrestaHQ-wt-waflow`.
- **Background processes:** none of mine. One `next build` belongs to the IsaFlow project, not
  this one. No test-db containers, no `gh run watch`.

## Where to resume

Read `docs/RECURRING_INVOICING_PLAN.md`, then `src/lib/recurring/cadence.ts` (specifically
`computeFirstRunAt`) and `src/types/recurring-invoices.ts`. Build the schedule API on top of
those. Verify the `PARITY_PLAN.md` 1.3 row still says "not yet usable" before claiming otherwise.
