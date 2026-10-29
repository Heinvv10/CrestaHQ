# Products + Invoices (v1, extends Quotes)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

A reusable product catalog plus an Invoice document type that shares the Quotes collection. Built on top of v1 Quotes; same Firestore doc family, same builder, same public view — extended in three ways:

1. **`kind: "quote" | "invoice"` on the quotes doc.** A document starts life as either, or an accepted quote is converted to an invoice in place via `POST /api/sub-accounts/[id]/quotes/[quoteId]/convert-to-invoice` (kind flips, `INV-YYYY-NNNN` number issued, public token rotated). State machines diverge: quotes go `draft → sent → viewed → accepted → paid`; invoices go `draft → sent → viewed → paid` (no accepted step — operator confirms payment landed in Stripe and clicks Mark as paid).

2. **`products/{id}` collection.** Per-sub-account catalog: `name`, `description`, `unitPriceCents`, `currency`, `active`. The builder's "Add from catalog" picker snapshots `{name, description, unitPriceCents}` into the line item — editing/archiving a product later never mutates historical docs (the snapshot is authoritative; `lineItem.productId` is a back-reference). Routes: `GET|POST /api/sub-accounts/[id]/products`, `PATCH|DELETE /api/sub-accounts/[id]/products/[productId]`.

3. **Per-sub-account PayPal.me payment links (v1) / own-Stripe card rail (Payments v1, in progress).**

> **Superseded in part by Payments v1** (`PAYMENTS_V1_PLAN.md`). The card rail is
> **Tier 1: the sub-account pastes its own Stripe RESTRICTED key** — NOT Stripe
> Connect. Connect would make every buyer a Stripe *platform* (each deployment
> has its own `STRIPE_SECRET_KEY`), requiring a Connect platform profile + Stripe
> review per buyer and KYC per client. Tier 1 avoids all of that; Connect stays
> available later behind one branch in `getSubAccountStripe()`. **Payments v1 is
> further along than this note used to say** (corrected 2026-09-04): the
> connection, hosted checkout pages, order bumps, the `orders` collection, the
> per-sub-account webhook at `/api/webhooks/stripe/sa/[subAccountId]` and the
> `order-reconciler` are all built, and an invoice paid by card is marked paid
> automatically through the same `markQuotePaidServerSide` the manual button
> uses — there is no second paid-path. PayPal.me remains the only manual rail,
> because paypal.me has no payment callback. The paragraph below still
> describes the shipped PayPal path, which is untouched. Each sub-account pastes a PayPal.me username under `/sa/[id]/dashboard/settings` → **Payments — PayPal**; no API keys, no encryption layer, no platform credentials. On invoice send, `/api/sub-accounts/[id]/quotes/[quoteId]/send` generates `https://paypal.me/{username}/{amount}{currency}` from the invoice total and caches it on the doc as `paymentLinkUrl`. The recipient sees a **Pay** button on the public invoice page that opens the PayPal-hosted page with the amount pre-filled. paypal.me URLs are stateless — every send regenerates the URL (no API call, no "old link" to deactivate). Operator marks invoices paid manually after the payment lands in their PayPal account. The card upgrade is **Payments v1** above (own-Stripe restricted key, webhook-driven auto-mark-paid) — the Settings page's **Payments — Stripe** card is now that real connect flow, gated on `paymentsEnabledByAgency`.

**Orders needing attention.** When a card payment arrives but cannot settle what it paid for (invoice already paid, total changed, booking no longer waiting), the reconciler writes `order.attention` and sets `attentionOpen: true`. Reports → Payments lists open ones at the top for sub-account admins and the agency owner (collaborators don't see it), with **Mark resolved** (`GET/POST /api/sub-accounts/[id]/order-attention`), which sets `attentionOpen: false` + `attentionResolvedAt/ByUid/ByEmail` on the order; the orders table then shows the note as resolved. One flag per order + source, whatever the note's wording, so a redelivery neither re-emails nor reopens it. The sub-account's admins get one email per flag. Orders flagged before this shipped have no `attentionOpen` and are not listed. Details: [client-billing.md → Flagged payments](client-billing.md#flagged-payments-attention).

## Sell online (upstream 1.0.54 F1 — model + editor only, NOT runtime-verified)

A product can be put on sale with its own buy link (`/co/[sa]/buy/[slug]`). **F1 ships only the data model, the server validation and the editor**: the public buy pages and payment sessions land in F2/F3, so a buy link shown in the editor 404s until then. Gated by `sellOnlineEnabledByAgency` (default off, [feature-gates.md](../architecture/feature-gates.md)); while off the Products dialog shows no Sell online block and the request is unchanged. NOT runtime-verified: no tenant has the gate on and nothing can be bought yet.

- **Fields** (optional on `products/{id}`, absent = catalog-only): `sellOnline`, `slug`, `publicDescription`, `checkoutPageId` (a published checkout page selling this product, for the Buy button), `delivery` (`none` / `community` group+course / `download` link), `publicVersion` (bumped on public-facing edits and archive).
- **Validation** (`lib/server/products-sell-online-service.ts`, used by `POST …/products`, `PATCH …/products/[productId]` and the agent `update_product`):
  - A sell-online key present with the wrong type (`sellOnline: "true"`, a non-string `slug`/`publicDescription`, a `checkoutPageId` that is neither a string nor null, a non-object `delivery`) answers 400; nothing is written.
  - Gate off: changing any sell-online field answers 403 `{ code: "gate_off" }`, except taking a product off sale (`sellOnline: false` alone), which is always allowed. Unchanged values round-tripped by the UI are a no-op 200.
  - Slug: lowercase kebab, 2–60 characters, not `api`/`new`/`thanks`/`preview`/`buy`; 409 when another product **or a checkout page** in the same sub-account uses it. Minted from the name on first sale, skipping both. Uniqueness is a query, not a claim doc (ruled 2026-10-30), so two simultaneous saves can still collide: **F2's slug lookup must fail closed — more than one product with the slug in the sub-account answers 404.**
  - While a product is (or becomes) for sale: price a whole number of cents above 0 and at most 100,000,000; currency one of `SELL_ONLINE_CURRENCIES` (the quote builder's list, incl. ZAR). Catalog-only products keep the old rules (price 0 allowed, any currency).
  - Turning it on, or changing an on-sale product's currency, needs a rail: `chooseProductPayRail(sub, currency)` (`lib/products/pay-rail.ts`, pure, also used by the editor). Stripe when Payments is on, `stripeConnectionMeta.ready` and Stripe can price the currency; else Paystack when Payments is on, a connection exists and the currency is ZAR. Both ready → Stripe (same order as invoices). Refusal: 400 `{ code: "no_pay_rail" }` with the reason.
  - Download links: public https only (no IP literal, localhost, userinfo or quote characters). Community/course and checkout page ids pass `isDocId`; the group must exist with Community on, the checkout page must be published and sell this product.
  - The PATCH validates and writes in one transaction against the product as it is at commit.
- **Hard delete** (`DELETE …/products/[productId]?hard=true`) of a product on sale answers 409 `{ code: "on_sale" }` ("take it off sale first"), re-checked in the delete's transaction. Archiving (the default delete) still works.
- **Agent tools:** a product on sale counts as sold (`productSellers` adds its buy link from the caller's own read of the product, inside the transaction for the re-checks), so the agent's `update_product` needs a person's "spend" approval for any edit of it (price and currency included), and `delete_product` is refused while it is on sale.
- **Snapshots** copy products catalog-only: the sell-online fields stay behind.
- **Checkout pages** created from a product skip reserved slugs.
- `listSellableProducts` (`lib/server/products-catalog-service.ts`) is the public catalog builder for F2/F6: on sale, valid price, and a rail for the currency right now.

**What F2 (buy pages + sessions) must do — F1 checks only at save time, and the world moves after it:**
- Slug lookup fails closed: more than one product with the slug in the sub-account → 404 (uniqueness is a query, not a claim doc).
- At render AND at session creation, re-check everything the save checked, from the stored docs: the product is `active`, `sellOnline`, its price passes `sellOnlinePriceError`, and `chooseProductPayRail(sub, currency)` is ok; a `checkoutPageId` still names a checkout page whose `productId` is this product and whose `status` is `published` (otherwise never send the buyer to that page); a `community` delivery's group (and course) still exists and Community is still on. The amount always comes from the product doc, never the request.

## Key files

- Types: [src/types/products.ts](../../src/types/products.ts), [src/types/quotes.ts](../../src/types/quotes.ts) (extended), `PayPalConfig` in [src/types/tenancy.ts](../../src/types/tenancy.ts)
- PayPal helper: [src/lib/paypal/payment-link.ts](../../src/lib/paypal/payment-link.ts) — `buildPaypalInvoiceUrl({ paypal, invoice })`, pure URL builder, no API call
- Settings UI: [src/components/settings/sub-account-paypal-section.tsx](../../src/components/settings/sub-account-paypal-section.tsx) (active), [src/components/settings/sub-account-stripe-section.tsx](../../src/components/settings/sub-account-stripe-section.tsx) (Payments v1 connect card — replaced the coming-soon placeholder; self-gates on `paymentsEnabledByAgency`)
- API: [src/app/api/sub-accounts/[id]/paypal-integration/route.ts](../../src/app/api/sub-accounts/[id]/paypal-integration/route.ts)
- Products UI: [src/app/(dashboard)/sa/[subAccountId]/products/page.tsx](../../src/app/(dashboard)/sa/[subAccountId]/products/page.tsx), Sell online block [src/components/products/product-sell-online-panel.tsx](../../src/components/products/product-sell-online-panel.tsx)
- Sell online: [src/lib/products/sell-online.ts](../../src/lib/products/sell-online.ts) (client-safe rules), [src/lib/server/products-sell-online-service.ts](../../src/lib/server/products-sell-online-service.ts), [src/lib/products/pay-rail.ts](../../src/lib/products/pay-rail.ts)
- Convert route: [src/app/api/sub-accounts/[id]/quotes/[quoteId]/convert-to-invoice/route.ts](../../src/app/api/sub-accounts/[id]/quotes/[quoteId]/convert-to-invoice/route.ts)

## What's intentionally NOT in v1

- **Stripe Connect.** Explicitly NOT the chosen path — see the Payments v1 note above. Connect makes each buyer a Stripe *platform* (platform profile + Stripe review per buyer, KYC per client). Tier 1 (own restricted key) ships instead; Connect remains a later option behind one branch in `getSubAccountStripe()`.
- **Webhook auto-mark-paid.** PayPal.me has no payment-status callback — the operator marks PayPal invoices paid manually. Payments v1's Stripe rail fixes this for card payments (Phase B wires it into invoices).
- **Recurring/subscription products** — one-off only.
- **Partial payments / deposits.** Defer until asked.
- **PDF download in v1?** Already shipped — operator's PDF button on the detail page + recipient's "Download PDF" link on the public invoice view ([src/lib/quotes/pdf-document.tsx](../../src/lib/quotes/pdf-document.tsx)).
- **PayPal Invoicing API or Partner Referrals.** Full PayPal integration would give webhooks + branded invoices but requires per-sub-account API credentials. paypal.me is enough for MVP.

## Setup contract

**No new env vars.** PayPal.me is a public username, not a secret — no encryption layer, no `SUB_ACCOUNT_KMS_KEY`, no platform credentials. Sub-account owners paste their PayPal.me username under Settings → Payments and they're done. Reuses `RESEND_API_KEY` + `EMAIL_FROM` (invoice email send), `AUTOMATIONS_TOKEN_SECRET` (public-link HMAC), Firebase (storage), `NEXT_PUBLIC_APP_URL` (public URL construction).

