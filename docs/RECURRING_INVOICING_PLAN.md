# Recurring invoicing — Phase 1.3

**Date:** 2026-09-04 · Scopes task 1.3 of [PARITY_PLAN.md](PARITY_PLAN.md).
Grilled and locked before any code was written.

## What this is

A sub-account can put an invoice on a cadence. A daily cron raises the next
invoice from a stored template, numbers it, and — unless that schedule is marked
review-first — emails it to the customer with the payment link the workspace
already has.

**This is the generate-and-send arm only.** Charging a saved card without the
customer acting is a second, later mode on the same schedule document. See
"Explicitly NOT in this phase".

## Why the engine and the rail are separate builds

The obvious shape is "recurring invoice = subscription": store a card, charge it
monthly, email a receipt. That shape is unavailable here, and the reason is
structural rather than a matter of effort.

**Stripe does not onboard South African entities.** Every one of CrestaHQ's
client sub-accounts is an SA business, so none of them can hold the Stripe
account that the client-facing payments rail requires. That rail
(`src/lib/stripe/sub-account-client.ts`, a restricted key pasted by the
sub-account) is additionally hard-coded to `mode: "payment"` — one-off charges
only, no subscription surface at all.

So auto-charge means Paystack, and Paystack is a different provider with
different failure semantics. Meanwhile the parts that make recurring invoicing
useful — the schedule, the template, the generation transaction, the numbering,
the send — care about none of that.

Splitting them means the engine ships and is verifiable now against real
behaviour, instead of waiting behind a payment provider and arriving
mock-verified. That trap is already documented twice in this repo, for the
WhatsApp Cloud rail and for `PaystackBillingProvider`.

## Locked decisions

### 1. Auto-send by default, review-first per schedule

Each schedule carries `reviewFirst`. Default `false`: the cycle generates and
sends. Set `true` and the cycle generates a **draft** and notifies the operator,
who sends it by hand.

Auto-send is the automation being bought, so it is the default. But a recurring
invoice is outbound customer communication that demands money under the client's
brand — get the template wrong and it goes out wrong *every cycle*. The flag
exists so a nervous operator, or a high-value customer, can keep a human in the
loop without losing the schedule.

### 2. Generate on cadence regardless of payment state; escalate past a threshold

An unpaid cycle never stops the next one being raised. The debt is real and
silently ceasing to bill a slow payer is worse than billing them twice.

The schedule instead tracks `consecutiveUnpaid`. Once it reaches
`unpaidEscalationThreshold` (default 2, `0` disables), the run creates a Task
and notifies the operator. That is the difference between a customer with a
dead card quietly accumulating four invoices and someone actually looking.

### 3. The schedule is its own document, not a field on an invoice

`recurringInvoices/{id}` is a top-level collection holding the template plus
schedule state. Each cycle mints an ordinary `quotes/{id}` document with
`kind: "invoice"`.

A recurrence field on an invoice would make the most recent generated invoice
double as the template, so editing history would change the future and the
schedule would have no place to live once an invoice is paid. Generated invoices
carry `recurringInvoiceId` as a back-reference; nothing reads back the other way
to find the template.

This mirrors `voiceCampaigns` → `recipients`: a parent holding intent and
totals, children that are ordinary domain documents.

### 4. Line items are snapshotted, exactly like the catalog already does

The template holds its own `lineItems[]`. Editing the template changes future
cycles and never a generated invoice. This is the same rule
`products` → quote line items already follows, and for the same reason: a
generated invoice is a historical record of what was billed.

### 5. Month-end is clamped from the anchor, not rolled

A schedule anchored to the 31st bills on the 28th in February, the 29th in a
leap year, and returns to the 31st in March. It never rolls into the next month.

Clamping keeps the anchor stable across the year. Rolling would silently walk a
month-end schedule forward until it drifted into the following month.

The clamp is always recomputed **from the stored anchor**, never from the
previous cycle's already-clamped day. Otherwise 31 Jan → 28 Feb → 28 Mar, and
one February permanently costs the schedule its month-end anchor. That is the
sharpest bug available in this module and it is the first test written.

### 6. The send path gets extracted to a service

`POST /api/sub-accounts/[id]/quotes/[quoteId]/send` holds ~247 lines of send
logic that a cron cannot call. It moves to `sendQuoteServerSide()` in a new
`src/lib/server/quote-send-service.ts` — a new file rather than an append to
`quotes-service.ts`, which the 300-line cap would not survive. The route becomes
a thin caller that keeps auth and passes the territory check in as a hook.

This is the one part of this phase that touches a live customer-facing path, so
it lands with tests that pin the existing behaviour **before** the extraction is
trusted — token rotation, `viewedAt` reset on resend, the PayPal link mint, the
503 when no payment rail is configured, and the activity/webhook side effects.

## Data model

`recurringInvoices/{id}` — top-level, server-only writes (default-deny rules,
so **no rules deploy is needed**; reads go through the admin API like
`customAgents`).

| Field | Purpose |
|---|---|
| `agencyId` / `subAccountId` / `createdByUid` | tenancy, as every document here carries |
| `contactId` | who is billed |
| `name` | operator label, e.g. "Acme retainer" |
| `status` | `active` / `paused` / `completed` / `cancelled` |
| `currency`, `lineItems[]`, `globalDiscount`, `globalTaxPercent` | the money template |
| `termsAndNotes`, `billedToOrganization`, `billingAddress`, `paymentDueDays` | the document template |
| `cadence` | `{ unit: "week" \| "month" \| "quarter" \| "year", interval: number }` |
| `anchorDay` | day-of-month for month-based cadences, clamped per §5 |
| `startAt`, `nextRunAt` | when it begins, when it next fires |
| `endMode` | `never` / `on_date` / `after_count` (+ `endAt` / `maxCycles`) |
| `reviewFirst` | §1 |
| `unpaidEscalationThreshold` | §2, default 2, `0` disables |
| `cyclesGenerated`, `lastRunAt`, `lastInvoiceId` | run state |
| `consecutiveUnpaid`, `lastEscalatedAt` | arrears state |

Generated invoices gain one optional field on the existing `Quote` type:
`recurringInvoiceId`.

Each schedule also stores an IANA `timezone` (defaulting to the sub-account's,
else UTC). "Bill on the 1st" has to mean the 1st where the business is, so all
day arithmetic happens in that zone and is baked into `nextRunAt` when it is
computed. The cron itself then only ever compares `nextRunAt <= now`.

**Indexes required** — `firebase deploy --only firestore:indexes` after pulling:

- `recurringInvoices(status, nextRunAt)` — the sweep.
- `quotes(recurringInvoiceId, status)` — the arrears recount per schedule.

## The run

`leadstack-recurring-invoices`, daily, appended to `SCHEDULES` in
`src/lib/qstash/register-schedules.ts` → `POST /api/cron/recurring-invoices`
(QStash-signature-verified, added to `PUBLIC_PATH_PATTERNS`).

Per due schedule:

1. **Claim in a transaction.** Re-read, re-check `status === "active"` and
   `nextRunAt <= now`, advance `nextRunAt`, increment `cyclesGenerated`. A QStash
   retry re-entering the same schedule finds `nextRunAt` already advanced and
   does nothing. This is the same claim-to-make-idempotent shape the social
   publish callback uses.

   **Idempotency lives on the schedule, never on invoice status.** This is a
   constraint, not an implementation detail. The send path swallows a failed
   lifecycle write while the email still goes out, so an invoice can sit at
   `draft` with no `sentAt` after the customer already received it. Any sweep
   that decides what to send by reading invoice status would re-send that
   invoice on the next tick — to a paying customer, every night, until someone
   noticed. Nobody may add a "re-send unsent invoices" pass on top of this
   engine without fixing that write first.
2. **Generate** — `issueQuoteNumber(subAccountId, "invoice")`, write the invoice.
3. **Send**, unless `reviewFirst`. The existing route sets `Reply-To` to the
   caller's email; a cron has no caller, so it uses the sub-account's account
   contact instead. A customer replying to an automated invoice must reach a
   human, not a shared sender nobody watches.
4. **Arrears** — recount unpaid generated invoices; escalate past the threshold.
5. **Complete** the schedule when `endMode` is satisfied.

Batch-capped with self-continuation, copying `api-cleanup`.

## The operator surface

`/sa/[id]/quotes/recurring` — list, create, edit, pause, resume, cancel — over
`GET`/`POST /api/sub-accounts/[id]/recurring-invoices` and `GET`/`PATCH` on
`/[recurringId]`.

**Admin-only**, unlike one-off quotes: a schedule demands money every cycle with
nobody watching. It also means territory scoping never applies here, because
admins are never scoped.

The money template is the ordinary `QuoteBuilder` — a recurring invoice's
template *is* an invoice, and a second line-item editor would be a second place
to fix every bug in the first. Only the cadence is new UI, and it has no
day-of-month control: the billing day is the start date's day, previewed as a
real date so nothing is inferred.

Contact and start date are fixed after creation; both are what the invoices
already raised were raised against. Changing the cadence or the anchor
recomputes `nextRunAt` **from today**, never earlier — the stored value came
from the old cadence — and never at or before `lastRunAt`, so an edit cannot
re-bill the cycle a sweep already billed that day.

**A billing-day (anchor) change on a schedule that has billed is pro-rated**
([src/lib/recurring/prorate.ts](../src/lib/recurring/prorate.ts)). Each invoice
pays for its period in advance, so the 15 Jun invoice covers the customer until
15 Jul. Moved to the 20th, the uncovered 15–20 Jul is raised **at the edit** as
one one-off invoice, "Pro-rated: 15 Jul – 20 Jul (billing day changed)" — at the
edit rather than on 15 Jul because every schedule invoice bills in advance, and
this needs no second trigger in the sweep. Moved the other way (20th → 15th),
the 15 Jul invoice carries a pro-rated credit for 15–20 Jul. Amount = the
template total × days ÷ days in the cycle those days start (old anchor for a
gap, new for an overlap), in the schedule's timezone, to the cent. The gap
invoice respects `reviewFirst` (a draft) and is **emailed even on a card
schedule**: the customer authorised one fixed amount per cycle, and this is not
it. For the same reason a credited invoice is never auto-charged — the card
cycle emails it, and the W5 period guard is checked before the amount, so the
Task names the billing-day change when that is the cause.

Quote lines are clamped to ≥ 0 everywhere (calc, sanitiser, builder), so the
credit is a flat discount (added to any template discount) plus a zero-priced
line naming it — a negative line would vanish the moment an operator saved a
review-first draft. What was pro-rated lives on the schedule as `proration`:
how far the customer is paid, a credit and the cycle it is owed on, the gap
invoiced. A second change before the next bill starts from that, so 15 → 20 →
15 credits back what the pro-rata charged, and saving the same edit twice
raises nothing. The edit and its pro-ration commit in one transaction against
the state they were computed from; a concurrent edit gets a 409.

Not pro-rated: a schedule that has never billed; a paused one; and any
**frequency change** (monthly ↔ quarterly/weekly), which redefines what a cycle
is worth — the next run simply moves. If a frequency change or a resume moves
the cycle a pending credit was owed on, the credit is not applied, and the
operator gets `lastError` and a Task to credit it by hand. A billing day can
only be changed through the API today; the form has no day-of-month control.

Resuming a paused schedule keeps a
cycle due today that was never billed, steps past cycles due before today, and
names the skipped dates in `lastError` so they can be raised by hand. A
schedule whose contact has been deleted is paused by the sweep, with the
reason in `lastError`. `completed` is the engine's word and cannot be set by an
operator; `cancelled` is terminal, because resuming billing after a cancellation
is a new agreement.

There is no `DELETE`. A schedule that has billed somebody is the record of why
those invoices exist.

## Acceptance criteria

1. A monthly schedule anchored to the 31st generates on 31 Jan, 28 Feb, 31 Mar —
   proven by tests over a fixed clock, not by waiting a month.
2. A cycle sends a real invoice email carrying a working payment link, and the
   existing Stripe webhook still marks it paid through the one existing
   mark-paid path.
3. `reviewFirst` generates a draft and sends nothing.
4. Re-delivering the same cron callback generates exactly one invoice.
5. A schedule whose `endMode` is satisfied stops and reports `completed`.
6. Extracting the send service changes no observable behaviour of the existing
   send route — pinned by tests written before the extraction.

## Explicitly NOT in this phase

**Auto-charge** (`chargeMode` on the schedule, a stored Paystack authorization,
retry and dunning on a failed charge) · agency→sub-account recurrence, which is
Phase 1.1 · proration of a template change applying to an open cycle (billing-day
changes are pro-rated — see above) ·
recurring *quotes* (invoices only) · a customer-facing "manage my subscription"
page · usage-based or metered lines.

## Known risk

No agency feature gate is added. Invoicing is ungated today and a schedule only
exists because an operator deliberately created one for a named contact, so
blast radius is bounded by an explicit act rather than by a switch. If recurring
invoicing later grows a rail that spends agency resources, it gains a gate then.

---

## Found while extracting the send path — NOT fixed here

Pinning the route's behaviour with tests surfaced two pre-existing defects. Both
were preserved verbatim, because a refactor that quietly fixes things is a
refactor whose tests prove nothing. Each deserves its own change where the
behaviour difference is the point.

**A failed lifecycle write is swallowed, but the side effects still fire.** If
the `quotes/{id}` update throws, the route logs and continues, so the activity
row, the workflow trigger and the outbound webhook all announce a send against a
quote still stored as `draft`. Reporting failure would be wrong too — the email
really did go out. The honest fix is probably to retry the write, or to mark the
quote from the side-effect path, not to invert the swallow.

This matters more once a cron is sending: a human who sees a stuck `draft`
investigates, whereas a nightly job produces the same inconsistency unattended
and nobody looks.

**The send response echoes a stale payment link.** When nothing is minted — a
card-only invoice, since the card button is rendered live on the public page —
the response returns whatever `paymentLinkUrl` was already stored. If that value
is left over from an earlier PayPal configuration, the caller is handed a link
that points at the wrong rail.

Both are now covered by tests, so changing either will announce itself.
