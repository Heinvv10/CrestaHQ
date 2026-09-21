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
paystackReference, payerEmail, paidAt, createdAt, updatedAt }`. Type:
[`src/types/payment-links.ts`](../../src/types/payment-links.ts). Rules: member/owner read,
no client writes (like `orders`). No composite index — the list is one equality filter sorted in
memory.

- **Invoice link** (`invoiceId` set): amount = the invoice total at creation, in cents. Only a
  sent/viewed ZAR invoice qualifies. Description `Invoice INV-…`.
- **Ad-hoc link**: amount and description typed by the operator. Integer cents, R0.01–R1,000,000.
- No expiry. The operator can deactivate (no reactivate in PR1).

## Flows

1. **Create** — `POST /api/sub-accounts/[id]/payment-links` (any member; territory gate on the
   invoice's contact). Needs `paymentsEnabledByAgency` and a stored Paystack key.
2. **Pay** — `/pay/link/{token}`. The token is `{linkId}.{nonce}.{HMAC("paylink."…)}` and must
   equal the doc's `token`. GET shows description + amount and asks for an email (Paystack
   requires one). POST initializes a transaction with the **tenant's** secret key, the **doc's**
   amount, currency ZAR, and a fresh reference `pl-{linkId}-{16 hex}` per checkout (Paystack
   refuses a repeated reference, and a customer may open the link twice). An invoice link is
   refused if the invoice has since been paid or its total no longer equals the link's amount.
3. **Return** — Paystack redirects to `/pay/link/{token}?reference=…`. The page says
   "confirming" and writes nothing.
4. **Reconcile** — `/api/webhooks/paystack/sa/[subAccountId]`, after its existing signature
   check, hands `charge.success` to
   [`payment-link-reconciler.ts`](../../src/lib/paystack/payment-link-reconciler.ts).

## Guards in the reconciler

- Reference not `pl-…` → ignored (the tenant's Paystack may run other integrations).
- Link missing, or `link.subAccountId` ≠ the webhook's sub-account → never paid, checked before
  Paystack is asked.
- `GET /transaction/verify/:reference` with the tenant key; must return `status: success`, the
  same reference, `amount === link.amountCents`, currency `ZAR`. The webhook body's own amount is
  never used.
- Marked paid in a Firestore transaction; a replay finds it paid and writes nothing. A second
  successful payment with a different reference is logged for a refund and does not overwrite
  the first.
- Invoice links then call `markQuotePaidServerSide` — the same path as the manual button and the
  Stripe reconciler. It runs on replays too (it is idempotent), so a redelivery finishes an
  invoice whose first attempt failed after the link was marked.
- Mismatch/foreign → log + 200. Only "could not reach Paystack" (network/5xx) answers 503 so
  Paystack redelivers.

## UI

Quotes & invoices → **Payment links** (`/sa/[id]/quotes/payment-links`, `max-w-5xl`): ad-hoc form
and every link with status, copy and deactivate. A sent invoice gets a **Paystack link** button
next to Mark as paid. Both hide unless Paystack is connected.

## Out of scope (PR2)

Sending via the inbox, refunds, partial payments, reactivation, link expiry, non-ZAR.
