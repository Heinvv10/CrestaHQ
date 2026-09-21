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
livemode, paystackReference, paystackDomain, payerEmail, paidAt, extraPayments?, attention?,
invoiceSettledAt?, createdAt, updatedAt }`. Type:
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

`livemode` is stamped from the connection (`sk_test_` → false) when the link is made. Test links
are allowed — #1000 is proven in test mode by design — but they are labelled everywhere: the pay
page shows "TEST MODE — no real money will be taken", and the list shows a TEST MODE badge. The
reconciler stores Paystack's `domain` and refuses a transaction whose domain doesn't match the
link's mode. There is no paid transition: it answers 200 and sets `attention` on the link.

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
- `GET /transaction/verify/:reference` with the tenant key. It must return `status: success`, the
  same reference, `requested_amount === link.amountCents`, `amount >= requested_amount` (no
  partial payment) and currency `ZAR`. `requested_amount`
  is used because `amount` includes the fees when the customer pays them (PaystackOSS/openapi
  `VerifyResponse`). The webhook body's own amount is never used.
- **Not gated** on `paymentsEnabledByAgency`: money already taken is always recorded.
- Marked paid in a Firestore transaction. A replay finds it paid and writes nothing. A second
  successful payment with a different reference is added to `extraPayments` in the same
  transaction, once only, and the list shows "Paid twice — refund owed". It never overwrites
  the first payment.
- The invoice step runs **at least once**, and its side effects fire **exactly once**. The link
  commits paid first. The invoice step then ends by writing `invoiceSettledAt` (with any
  `attention`). If the process dies in between, or the step throws, the route answers 503.
  The redelivery arrives as a replay of the link's own reference, finds the link unsettled
  (no `invoiceSettledAt` and no `attention`), and runs the step again. It is safe to repeat
  because `markQuotePaidServerSide` checks and writes in one Firestore transaction
  (compare-and-set), and only the winner fires the activity, trigger, webhook and review ask.
  That also covers two links for one invoice, or a link racing the manual Mark as paid. The
  side effects after the commit never throw. The step first re-checks the invoice. If it
  is missing, already paid, or its total or currency no longer match the link, the link stays
  paid and gets an `attention` message, and the invoice is not marked paid. Otherwise it calls
  `markQuotePaidServerSide`, the same path as the manual button and the Stripe reconciler. A
  refusal (for example the invoice went back to draft) or an exception also becomes
  `attention`. The list shows it in red.
- Verify failures: only a genuine not-found (HTTP 404, or 400 "…not found") is final and
  answers 200. 429, 401/403 (rotated key), any other 4xx, 5xx and network errors answer 503, so
  Paystack redelivers. `BillingError.providerStatus` carries Paystack's HTTP status, and Client
  Billing's 400/502 mapping is unchanged. A mismatch or a foreign reference is logged and
  answered 200.

## UI

Quotes & invoices → **Payment links** (`/sa/[id]/quotes/payment-links`, `max-w-5xl`): ad-hoc form
and every link with status, copy and deactivate, plus the refund-owed and attention notes. It
shows a loading state first, and "Locked by your agency" when Payments is off. The **Payment
links** button on the quotes page hides in that case. A sent invoice gets a **Paystack link**
button next to Mark as paid. It hides unless Payments is on and Paystack is connected.

## Out of scope (PR2)

Sending via the inbox, refunds, partial payments, reactivation, link expiry, non-ZAR.
