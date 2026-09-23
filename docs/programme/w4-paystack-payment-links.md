# W4 · Paystack payment links

*Part of the [CRM gap programme](README.md) ("Payment links, text-to-pay via Paystack").*

**Goal:** a sub-account operator makes a link for an invoice or an ad-hoc amount; the customer
pays on Paystack into the sub-account's OWN Paystack account; the link (and the invoice) show
paid only after Paystack's verified webhook, never because the customer came back from checkout.

| PR | Scope | State |
|---|---|---|
| PR1 | Model, create/deactivate, public pay page, webhook reconciler, minimal operator UI | this PR |
| PR2 | Send the link from the inbox (WhatsApp/SMS/email), refunds, partial payments | not started |

## Model

`paymentLinks/{id}`: `{ agencyId, subAccountId, createdByUid, invoiceId | null, contactId | null,
description, amountCents, currency: "ZAR", token, active, status: "open" | "paid",
paystackReference, paystackDomain, payerEmail, paidAt, extraPayments?, attention?,
invoiceAttention?, invoiceSettledAt?, createdAt, updatedAt }`. Invoices gain `paidVia`
(`{ rail: "paystack_link", linkId, reference }` or null), written by `markQuotePaidServerSide`
together with `status: "paid"`. Clients may not set or change `paidVia`: the `quotes` create
and update rules refuse it, so only the Admin SDK writes it. The repo has no Firestore
rules-test harness (no emulator here), so this rule is not covered by an automated test. Type:
[`src/types/payment-links.ts`](../../src/types/payment-links.ts). Rules: member/owner read,
no client writes (like `orders`). No composite index — the list is one equality filter sorted in
memory.

**Read rule has no territory clause — deliberate.** It mirrors `orders`, the other record of
money taken. A territory clause would need every link to carry a `contactId`, and ad-hoc links
have none. So a territory-scoped collaborator can *see* every link in the sub-account, which
shows amounts and descriptions and nothing from contact records. They cannot create or
deactivate a link for a contact outside their territory: both API routes run
`territoryGateForContact`. Revisit if a tenant's territories hold data that must not be seen
across territories.

- **Invoice link** (`invoiceId` set): amount = the invoice total at creation, in cents. Only a
  sent/viewed, unexpired ZAR invoice qualifies. Description `Invoice INV-…`.
- **Ad-hoc link**: amount and description typed by the operator. Integer cents, R0.01–R1,000,000.
- One open link per invoice: creating again returns the existing active, unpaid link. A
  deactivated or paid one doesn't count, so a new link can be made after deactivating.
- No expiry. The operator can deactivate (no reactivate in PR1).

## Test mode

Mode belongs to the **checkout attempt** (W5 PR1, see
[w5-paystack-auto-charge.md](w5-paystack-auto-charge.md)):

- Each checkout writes `paymentAttempts/{reference}` **before** Paystack is called, in a
  transaction that reads the stored key: `mode` and a key fingerprint (a truncated SHA-256,
  never the key), amount, currency, the link, and `state` (`open` → `settled` / `refused` /
  `flagged`, with `reason`).
- A link records the mode it was **issued** in (`paymentLinks.mode`) and is paid only in that
  mode. After the workspace switches between test and live, the pay page refuses the link
  (410, "ask for a fresh link") and the list says so; creating a link for the invoice again
  withdraws the old one. So a live invoice link can never become a test checkout (the round-5
  HIGH), and a test link can never charge real money under a "no real money" banner.
- The banner shows the link's mode, which the checkout transaction re-checks against the key it
  records on the attempt: what the payer is shown is what is charged.
- The reconciler requires the verifying key's fingerprint to be the attempt's, and Paystack's
  `domain` to be the attempt's mode. A mismatch never marks anything paid: it answers 200 and
  flags the attempt, with a sentence on the link's `attention`.
- **Connection changes.** Disconnecting or replacing a key commits first — Paystack being slow
  never holds up removing a key. The attempts that were open under the outgoing key are then
  checked with Paystack using that key (held in memory, 5 s per call): a success is recorded
  through the reconciler; `reversed` or unknown to Paystack is closed as `refused`; `abandoned` or
  `failed` is closed only if its link is already paid or withdrawn, because Paystack lets the
  customer resume or retry on the same reference. So a routine key regeneration, and abandoned
  checkouts on paid links, raise no false alarms. Anything still open under another key is then
  flagged, with its reference and amount, on the link's `attention`. A
  webhook that arrives for such an attempt (no key, or signed by the replaced key) cannot be
  verified, so nothing is recorded; it flags the attempt if the change missed it and answers
  200 rather than 401 so Paystack stops redelivering. A flag is built from our own attempt
  record — nothing in the unverified body is trusted. A flagged attempt still settles if its
  own key is reconnected and the payment then verifies.
- A verified payment with **no** attempt (a checkout opened before attempts existed) is flagged
  on the link, never recorded. Links made before `mode` existed are refused at the pay page;
  a payer returning from Paystack (`?reference=`) is always told the payment is being confirmed,
  never that the link is dead.

## Flows

1. **Create** — `POST /api/sub-accounts/[id]/payment-links` (any member; territory gate on the
   invoice's contact). Needs `paymentsEnabledByAgency` and a stored Paystack key.
   Deactivate: `PATCH …/[linkId]` `{active:false}`, with the same territory gate on the link's contact.
2. **Pay** — `/pay/link/{token}`. The token is `{linkId}.{nonce}.{HMAC("paylink."…)}` and must
   equal the doc's `token`. GET shows description + amount and asks for an email (Paystack
   requires one). POST initializes a transaction with the **tenant's** secret key, the **doc's**
   amount, currency ZAR, and a fresh reference `pl-{linkId}-{16 hex}` per checkout (Paystack
   refuses a repeated reference, and a customer may open the link twice). Refused when the
   agency has switched Payments off since (like the Stripe invoice pay route), and, for an
   invoice link, when the invoice has been paid, has expired, or its total no longer equals the
   link's amount.
3. **Return** — Paystack redirects to `/pay/link/{token}?reference=…`. The page says
   "confirming" and writes nothing.
4. **Reconcile** — `/api/webhooks/paystack/sa/[subAccountId]`, after its existing signature
   check, hands `charge.success` to
   [`payment-link-reconciler.ts`](../../src/lib/paystack/payment-link-reconciler.ts).

## Guards in the reconciler

- Reference not `pl-…` → ignored (the tenant's Paystack may run other integrations).
- Link missing, or `link.subAccountId` ≠ the webhook's sub-account → never paid, checked before
  Paystack is asked.
- `GET /transaction/verify/:reference` with the tenant key. A result that is not a success, or
  that names a different reference, means nothing was received: it is logged and answered 200.
  A **verified success** must also match the link: `requested_amount === link.amountCents`,
  `amount >= requested_amount` (no partial payment), currency `ZAR`, and Paystack's `domain`
  equal to the attempt's mode (see Test mode). `requested_amount` is used because `amount` includes the fees when
  the customer pays them (PaystackOSS/openapi `VerifyResponse`). The webhook body's own amount
  is never used. If a verified success does not match, money did arrive on the tenant's
  account, so the link gets `attention` ("does not match this link — check your Paystack
  dashboard", or the test/live wording). There is still no paid transition, and it answers 200.
- **Not gated** on `paymentsEnabledByAgency`: money already taken is always recorded.
- Marked paid in a Firestore transaction. Any `attention` is kept, not cleared: it records a
  real mismatched payment that may need a refund. A replay finds the
  link paid and writes nothing. A second successful payment with a different reference is
  added to `extraPayments` in the same transaction, once only, and the list shows "Paid twice
  — refund owed". It never overwrites the first payment.
- **Two flags.** `attention` is for pre-payment problems (above). `invoiceAttention` is for the
  invoice step and is written together with `invoiceSettledAt`.
- **The invoice step runs at least once.** The link commits paid first, and the step ends by
  writing `invoiceSettledAt`. If the process dies in between, or a transient Firestore error
  answers 503, the redelivery arrives as a replay of the link's own reference. It sees
  `invoiceId && !invoiceSettledAt` and runs the step again, whatever `attention` says.
- **Recognising its own success.** `markQuotePaidServerSide` checks and writes in one
  transaction (compare-and-set) and records `paidVia` in that same write. It returns
  `already_paid` with the stored `paidVia`. So when the step finds the invoice paid, whether
  by reading it or by losing the compare-and-set, it compares `paidVia.reference` with this
  payment's reference:
  - **Same reference:** its own earlier success (an overlapping delivery, or a crash after
    the invoice committed). It is settled with no flag.
  - **Different or absent:** the invoice was paid another way (the manual button, Stripe,
    another link). `invoiceAttention` says a refund may be owed.
- **Manual Mark as paid inside the retry window.** If a paid link for the invoice has no
  `invoiceSettledAt` yet, the manual route passes that link's `paidVia`. The redelivery then
  recognises the invoice as paid by its own payment instead of flagging a refund.
- The step also flags an invoice that is missing, changed in total or currency, or refused by
  the paid path (for example back to draft). Total and currency are checked twice: on the
  step's own read, and again inside the compare-and-set (`expectTotalCents` /
  `expectCurrency` → `amount_changed`). An edit between the two therefore cannot mark a short
  payment paid. A deterministic error reading it, such as a
  malformed invoice, is terminal: `invoiceAttention` plus `invoiceSettledAt`, answered 200.
  Only transient errors answer 503.
- **Side effects fire at most once**, and only for the compare-and-set winner: activity,
  `quote.paid` trigger, webhook and review ask. A crash between the invoice's commit and its
  side effects skips them. That is pre-existing behaviour of the shared paid path, and out
  of scope here.
- Verify failures: only a genuine not-found (HTTP 404, or 400 "…not found") is final and
  answers 200. 429, 401/403 (rotated key), any other 4xx, 5xx and network errors answer 503, so
  Paystack redelivers. `BillingError.providerStatus` carries Paystack's HTTP status, and Client
  Billing's 400/502 mapping is unchanged. A mismatch or a foreign reference is logged and
  answered 200.

## UI

Quotes & invoices → **Payment links** (`/sa/[id]/quotes/payment-links`, `max-w-5xl`): ad-hoc form
and every link with status, copy and deactivate, plus the refund-owed note and both flags
(`attention`, `invoiceAttention`). It
shows a loading state first, and "Locked by your agency" when Payments is off. The **Payment
links** button on the quotes page hides in that case. A sent invoice gets a **Paystack link**
button next to Mark as paid. It hides unless Payments is on and Paystack is connected.

## Out of scope (PR2)

Sending via the inbox, refunds, partial payments, reactivation, link expiry, non-ZAR.

## Known gaps (accepted for PR1)

- **Stripe after Paystack.** A Stripe card payment arriving after a Paystack-link payment for
  the same invoice gets `already_paid` from the shared paid path. The Stripe order is
  recorded, but nothing flags the invoice as paid twice.
- **Concurrent creates.** Two concurrent creates for the same invoice can make two links: the
  one-open-link check is a plain query, not a transaction. If both are paid, the second is
  flagged "paid another way — refund may be owed".
- **Side effects at most once.** A crash between the invoice's paid commit and its side
  effects skips them (pre-existing, shared paid path).
