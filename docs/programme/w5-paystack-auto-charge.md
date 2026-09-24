# W5 — Paystack auto-charge (card on file) for recurring invoices

**Status:** SHIPPED 2026-09-23 — PR1 #190, PR2 #207, PR3 #220, plus #221 (ZAR in the
builders) and #225 (Paystack invoice send rail), all deployed. See [As built](#as-built) for
what changed from this plan and what is still open. The rulings below were settled with Hein
and are not to be re-opened.

A sub-account bills its own customers on a cadence. Today every cycle emails an invoice and
waits. This wave adds the second arm the 2026-09-04 recurring-invoicing grill locked but could
not build: the customer authorises a card once, and each cycle charges it unattended.

The customers being charged are the tenant's customers. They have no CrestaHQ login, so
nothing here suspends anyone's access to the app. Workspace access for non-payment already
exists in the other direction — agency → sub-account, `billing.status` / `graceUntil` and
[`billing-guard.tsx`](../../src/components/billing/billing-guard.tsx) — and is untouched.

## What exists already

| Piece | Where | State |
|---|---|---|
| Cadence, templates, month-end clamp, arrears Task | `recurring-invoice-service.ts`, `recurring-invoice-cycle.ts`, `cadence.ts` | live since 2026-09-05; no cycle has ever run on a real schedule |
| Invoice minting (`quotes` doc, `kind: "invoice"`) | `recurring-invoice-cycle.ts` `generateInvoice` | live |
| Marking an invoice paid, once, with a compare-and-set | `quotes-service.ts` `markQuotePaidServerSide` + `quote.paidVia` | shipped in #188 |
| Paystack per-sub-account key, webhook, signature check | `sub-account-client.ts`, `api/webhooks/paystack/sa/[subAccountId]` | shipped in #188 |
| Hosted checkout + public pay page | `payment-links-service.ts`, `pay/link/[token]` | shipped in #188, walked on #1000 in test mode |
| Storing a reusable authorization | — | **does not exist** |
| Charging a stored authorization | — | **does not exist**; agency billing reuses cards only via Paystack Subscriptions |

## Rulings

1. **We own the cadence; Paystack only charges.** Each cycle calls
   `/transaction/charge_authorization`. No Paystack Subscriptions: it has no proration, runs
   its own retry rules, and cannot clamp to month-end the way the recurring plan locked. Two
   schedulers for one customer is a disagreement waiting to happen.
2. **The mandate is a record, not a flag.** A customer authorises through a dedicated link
   that states the amount, the frequency and how to stop. Paying it both settles that cycle
   and creates the mandate. We store the authorization, plus the exact wording shown, the
   timestamp and the IP, as consent evidence.
3. **One attempt per cycle, no retries.** A decline emails that cycle's invoice with a payment
   link, records the reason on the invoice and the mandate, and counts through the existing
   `unpaidEscalationThreshold` Task. After the threshold of consecutive declines the mandate
   needs attention and later cycles email instead of charging. Retries are a later decision,
   with their own scheduling and exactly-once proof.
4. **Charge succeeded / charge failed are workflow triggers.** Built-in behaviour stops at the
   invoice, the Task and the arrears count. Anything reaching the customer is the tenant's own
   workflow, under its own approvals.
5. **PR1 closes #188's open findings first.** Auto-charge is unattended, so those gaps get
   worse: a live→test key switch would silently charge test money every cycle and mark real
   invoices paid, with nobody watching.
6. **Done is a test-mode proof on #1000** (see Validation). A live-money pilot on a real tenant
   is a separate decision, outside the Level-3 boundary.

## Verify before building

`charge_authorization` for ZAR merchants may require a subscription, or may be gated per
account. **The lane confirms this against Paystack's own docs and a test-mode call before
writing PR2.** If it is not available, ruling 1 is invalid and the lane stops and reports
rather than quietly switching to Subscriptions.

## Shape

### PR1 — attempt-scoped mode, and in-flight attempts (closes #188's open findings)

The bug #188 could not shake: test/live mode was first stored per link (a live key then charged
real money under a TEST MODE banner), then read from the current connection (a test card then
marked a real invoice paid). Mode belongs to neither. **It belongs to the charge attempt.**

- A `paymentAttempts/{reference}` record, written when a checkout or charge starts: reference,
  mode, a key fingerprint, amount, currency, what it is for, and its state.
- The webhook requires the attempt's mode and fingerprint to match what it verified. A mismatch
  never marks anything paid, and it flags the operator.
- An attempt still open when the connection is disconnected, switched or replaced is flagged,
  not dropped. That closes the two MEDIUMs where a real payment vanished silently.
- `pnpm test:rules` cases for `paymentLinks`, `paymentAttempts` and the `quotes.paidVia` lock.
  The harness exists (`src/lib/audit/audit-events.firestore-rules.test.ts`); #188 shipped
  without using it.

### PR2 — mandates

- `paymentMandates/{id}`: tenancy keys, contactId, Paystack authorization + customer code, card
  last4/brand/expiry for display, mode, consent snapshot (wording, timestamp, IP), status.
- A mandate link built on the #188 pay page, with the recurring terms shown above the button.
- Paying it stores the mandate and settles that cycle.
- A contact shows its mandate; revoking is one click and is not reversible.

### PR3 — the charge arm

- `chargeMode: "invoice" | "card"` on the schedule, defaulting to `"invoice"` so every existing
  schedule behaves exactly as today.
- A `"card"` cycle mints the invoice as it does now, then charges the mandate against a
  per-cycle attempt reference derived from the schedule and cycle number, so a replayed or
  retried cycle cannot produce a second charge.
- The webhook settles the invoice through `markQuotePaidServerSide` with
  `paidVia: { rail: "paystack_auto", mandateId, reference }`. Auto-charge never marks paid from
  the API response alone — same rule as #188.
- No mandate, a revoked mandate, or a mandate needing attention → email the invoice and tell
  the operator. Never skip the cycle in silence.
- Declines follow ruling 3. Both outcomes emit their workflow trigger.

## Validation (done means all of it, unattended)

On #1000, in test mode:
1. A mandate captured through the link; the consent snapshot stored.
2. A daily schedule set to `card` charges two consecutive cycles without intervention; each
   cycle's invoice flips to paid via the webhook, with `paidVia.rail = "paystack_auto"`.
3. A third cycle on a declining test card emails the invoice, records the reason, and raises
   the arrears Task at the threshold.
4. A replayed webhook and a re-run cycle produce no second charge and no second trigger.
5. Switching the connection to a different mode mid-cycle flags, and never marks paid.

### Validation results (#1000, test mode, 2026-09-23)

| # | Result |
|---|---|
| 1 | ✅ Mandate captured through the card-on-file link; wording, time and IP stored. |
| 2 | ✅ Two consecutive cycles charged and settled by the webhook with `paidVia.rail = "paystack_auto"`. There is no daily cadence (weekly is the minimum), so the week between cycles was simulated by moving the test schedule's dates and triggering the sweep through QStash. |
| 3 | ⚠️ Not walked live: Paystack's test checkout cannot produce a card that authorises and then declines. Covered by seam tests. |
| 4 | ✅ A re-triggered sweep and two replayed signed webhooks changed nothing. |
| 5 | ⚠️ Not walked live, to avoid switching #1000's connection. Covered by seam tests. |
| + | ✅ The period guard refused a cycle due minutes after the last one (no charge, Task raised). |
| + | ✅ After #225, a card schedule's first cycle on a Paystack-only workspace sent its invoice on its own with a card-on-file link. |

## As built

What changed from the plan above, and why:

- **The period guard.** An edit to a card schedule (billing day, frequency, or a switch through invoice mode) must not charge twice in one period. A guard at edit time kept leaking, so it moved to the charge: each billed cycle records `lastDueAt`, and a card charge is refused when this cycle's due date is less than one cadence period (with tolerance, `charge-gap.ts`) after the previous cycle's, however that cycle was paid. Legacy schedules fall back to `lastRunAt`. A refused cycle is emailed and raises a Task.
- **Charge outcomes.** Only Paystack `success` counts as accepted. `failed` or a 4xx decline is a decline. A 401 or 403 means our key was refused, which is not the card's fault, so the invoice is emailed, a Task is raised, and no decline is counted. Anything else, including pending and OTP states, 5xx, timeouts and duplicate references, is "unknown": nothing is emailed, a Task names the reference, and the operator's **Re-check card charge** button asks Paystack again and settles or declines from its answer.
- **Operator Tasks, not `lastError`.** `lastError` is cleared by the next cycle and by any edit, so everything that needs a human raises a Task.
- **Sending.** Before #225 a workspace with only Paystack could not send any invoice, so card mode could never get its first card-on-file link to the customer. Sending now picks a rail: a card-mode invoice gets a card-on-file link; otherwise PayPal, then Stripe, then a plain Paystack link. No pay link is sent while a card charge for the invoice is unsettled.

## Known gaps (accepted)

- A pending charge that later fails at Paystack is recorded only when the operator re-checks it; there is no `charge.failed` handler.
- For a schedule created before PR3, if its last pre-deploy bill was swept late, its first card cycle may be refused and emailed. This happens once per schedule.
- Moving the billing day 26 or more days later straight after a charge can put two charges in one calendar month. That is within the documented tolerance.
- If the operator marks an invoice paid by hand while a card charge is pending, a later webhook raises a "check a hand-marked invoice" Task rather than deciding which payment it was.

## Out of scope

Retries and dunning · refunds · customer-facing card-update pages · multi-currency (ZAR only) ·
Paystack Subscriptions · live-money pilots · anything touching workspace access.

## Known gaps carried in from #188

Recorded on the PR and still open: a Stripe payment arriving after a Paystack-link payment for
one invoice is not flagged as a double payment; two simultaneous creates can make two links for
one invoice; a crash immediately after an invoice is marked paid skips its side effects.
