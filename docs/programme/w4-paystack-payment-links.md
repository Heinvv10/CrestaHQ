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

There is **no per-link mode**. Everything uses the sub-account's *current* connection:
- the pay page banner reads `paystackConnectionMeta.livemode`;
- checkout charges with the stored key;
- the reconciler checks the key it verified with (`sk_live_…`).

So a link made under a test key and paid after the live key is connected is shown, charged and
recorded as live. An earlier design stamped the mode on the link, and that could take real money
under a "no real money" banner and then refuse to record it. Test mode is allowed (#1000 is
proven in test mode by design) and labelled. While the connection is in test mode, the pay page
shows "TEST MODE — no real money will be taken" and open links in the list show a TEST MODE
badge. The reconciler stores Paystack's `domain` and refuses a transaction whose domain doesn't
match the connection's mode. There is no paid transition: it answers 200 and sets `attention`
on the link.

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
  equal to the link's mode. `requested_amount` is used because `amount` includes the fees when
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
