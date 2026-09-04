# Quotes v1

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

GHL-style "Estimates" — operator builds a line-itemed quote inside a contact (or via the standalone Quotes tab), sends via branded email, recipient views + accepts/declines on a public landing page. **No inline payment collection in v1** — operator marks paid manually after receiving payment off-system. Mirrors GHL's Estimates feature (not their Invoices or Documents-with-e-signature; those are scoped for v2/v3).

## Data model

Quotes live in a flat top-level collection `quotes/{id}` rather than under a contact subcollection — the operator's standalone /quotes list page is the primary access path, and Firestore queries against subcollections-of-subcollections get awkward. Each doc carries the usual tenancy keys (`agencyId / subAccountId / createdByUid`) plus `contactId` for the per-contact subscription.

Money fields: `lineItems[]` (description, quantity, unitPrice — array stored inline because line counts are bounded and Firestore array updates are atomic enough at this scale), `globalDiscount` (`{type: "percent" | "flat", value} | null`), `globalTaxPercent`, `currency` (ISO 4217). Live totals come from [src/lib/quotes/calc.ts](../../src/lib/quotes/calc.ts)::`computeQuoteTotals()` — a pure function imported by the builder UI (live preview), the public view (recipient render), the email template (subject line), and the auto-deal helper (deal value = total). Single source of truth.

Lifecycle: `draft → sent → viewed → accepted | declined | expired → paid`. `expired` is **derived at read time** (`effectiveQuoteStatus()` returns "expired" when `validUntil < now` regardless of stored status) so we don't need a background sweep to flip it.

Quote numbers: `Q-YYYY-NNNN`, per-sub-account counter that resets each year. Issued atomically by [src/lib/quotes/number.ts](../../src/lib/quotes/number.ts)::`issueQuoteNumber()` via a Firestore transaction on `subAccounts/{id}/counters/quoteNumbers`. Two operators issuing simultaneously can't collide.

## Public token

The recipient-facing /q/[token] link uses a custom token shape `${quoteId}.${nonce}.${HMAC-SHA256}` (not the pure `id.HMAC` pattern unsubscribe links use). The 16-byte random nonce is the rotation primitive: every send (or re-send) mints a fresh token, and only the **SHA-256 hash** of the active token is persisted on the quote doc (`publicTokenHash`). Re-sending invalidates the previous link without needing to store a token blacklist. A Firestore admin dump can't be used to forge accept-requests — only the hash leaks, not the raw token.

Verification path: [src/lib/quotes/token.ts](../../src/lib/quotes/token.ts)::`verifyQuoteToken()` checks HMAC, then [src/app/q/[token]/page.tsx](../../src/app/q/[token]/page.tsx) and [src/app/api/quotes/[token]/respond/route.ts](../../src/app/api/quotes/[token]/respond/route.ts) each re-hash the presented token and compare against `quote.publicTokenHash`. Mismatch → 404 (don't reveal the quote exists). Uses `AUTOMATIONS_TOKEN_SECRET` — same env var as unsubscribe links; rotating it invalidates every outstanding quote link in addition to every unsubscribe link.

## Send flow

[src/app/api/sub-accounts/[id]/quotes/[quoteId]/send/route.ts](../../src/app/api/sub-accounts/[id]/quotes/[quoteId]/send/route.ts) is the only authenticated entry point that mints a token + sends an email. Sequence: verify sub-account member → load quote + contact + sub-account → check Resend is configured (`emailIsConfigured()`; 503 if not) → issue fresh token → render email via [src/lib/quotes/email.ts](../../src/lib/quotes/email.ts)::`renderQuoteEmail()` → `sendEmail()` with `Reply-To = caller.email` → write `{status: "sent", sentAt, viewedAt: null, publicTokenHash, updatedAt}` → fire lifecycle side-effects (activity row + automation trigger).

Email sender uses the deployment-wide `EMAIL_FROM` (per v1 locked spec — no per-sub-account custom sender yet). The body opens with `${businessName} has prepared a quote for your review.` so the recipient knows who sent it even with the shared sender address.

## Respond flow

[src/app/api/quotes/[token]/respond/route.ts](../../src/app/api/quotes/[token]/respond/route.ts) is the recipient-facing endpoint — no auth, token IS the credential. Sequence: verify token → parse `{action: "accept" | "decline", reason?, note?}` → Firestore transaction (re-read quote inside, verify hash + status + expiry, flip status + stamp the relevant timestamp). Transaction guard prevents two concurrent accepts from producing inconsistent state if the recipient triple-clicks on a slow connection.

After the transaction commits, [src/lib/quotes/lifecycle.ts](../../src/lib/quotes/lifecycle.ts) helpers fire side-effects: activity timeline row + automation trigger + (on accept, if `autoCreateDealOnAccept`) a new Deal at the "Won" pipeline stage with the quote total as value. All helpers swallow errors internally — a stale activity write can't 500 the recipient's accept click.

## Decline reason picker

Borrowed UX from GHL's Documents/Estimates flow: predefined reasons (`"Too expensive"`, `"Not the right fit"`, `"Bad timing"`, `"Going with a competitor"`, `"Other"`) + optional free-text note. `"Other"` requires a note. The reason + note land in `quote.declineReason` + `quote.declineNote` and surface in the operator's detail-page lifecycle timeline.

## Lifecycle side-effects

[src/lib/quotes/lifecycle.ts](../../src/lib/quotes/lifecycle.ts) owns three helpers wired into every state-changing route:
- `recordQuoteActivity(quote, event, opts?)` — writes a row to `contacts/{contactId}/activities` with type `quote_sent / viewed / accepted / declined / marked_paid`. Renders content using `computeQuoteTotals()` so the timeline reads "Quote Q-2026-0001 (USD $4,200.00) accepted by recipient." Visualised in [src/components/contacts/activity-timeline.tsx](../../src/components/contacts/activity-timeline.tsx) with brand-consistent icons (`FileSignature`, `Eye`, `CheckCircle2`, `XCircle`, `DollarSign`).
- `fireQuoteTrigger(quote, trigger)` — dispatches to the existing automations engine via `fireTriggers()`. `AutomationTriggerType` now includes the four quote events. **Caveat:** the only `recipeType` shipped is `instant_response`, which only handles `form_submit` in `computeFirstStepDelay()`. Creating a quote-triggered automation today creates the execution doc but produces no sends until v2 extends the recipe types. Dispatch plumbing is in place; recipe support is the missing piece.
- `applyDealOutcomeForAcceptedQuote(quote)` — the pipeline outcome of an accept, two paths. **Linked** (`quote.dealId` set via the builder's "Pipeline deal this quote is for" picker): moves THAT existing deal to "Won" and sets its value/currency to the quote total via `updateDealServerSide` — stage-move activity, `deal.won`/`deal.stage.changed` webhooks, and the `pipeline.stage.changed` workflow trigger all fire exactly as if the operator dragged the card. This avoids the classic duplicate (a Proposal-stage deal left open next to an auto-created Won deal). If the linked deal was deleted before acceptance it falls back to the unlinked path. **Unlinked** (every pre-linkage quote + quotes where no deal was picked): `autoCreateDealForAcceptedQuote(quote)` — when the per-quote `autoCreateDealOnAccept` checkbox is true (default), creates a Deal at the "Won" stage with the quote total. Stamps the operator's `createdByUid` so the deal appears in the pipeline as if they created it manually. Also writes a `pipeline_moved` activity entry so the timeline reads naturally. The link is validated at create/edit time (deal must exist in the same sub-account + belong to the quote's contact) and resets automatically if the operator re-picks the recipient.

## Operator UX

Two entry points (mirrors Deals + Tasks pattern):
1. **Sidebar → Quotes** → [src/app/(dashboard)/sa/[subAccountId]/quotes/page.tsx](../../src/app/(dashboard)/sa/[subAccountId]/quotes/page.tsx) — all quotes in the sub-account with filter chips (Draft / Sent / Viewed / Accepted / Declined / Expired / Paid) + status counts + search across quote number + contact name + billed-to-organization.
2. **Contact profile → Quotes section** → [src/components/contacts/contact-quotes.tsx](../../src/components/contacts/contact-quotes.tsx) renders below the Deals card, listing that contact's quotes with a "+ Quote" shortcut that opens the new-quote page pre-selecting the contact.

The detail page ([src/app/(dashboard)/sa/[subAccountId]/quotes/[id]/page.tsx](../../src/app/(dashboard)/sa/[subAccountId]/quotes/[id]/page.tsx)) toggles between **view mode** (read-only summary + Send / Mark-paid / Delete / Edit actions) and **edit mode** (mounts the builder for inline updates). Sent quotes are editable per the locked v1 spec — operator can fix typos and re-send without creating a new revision (revision tracking is a v2 add).

## What's intentionally NOT in v1

- **Inline Stripe payment collection** — operator marks paid manually. v2 adds a "Pay now" button on the public page that opens a Stripe Checkout session and auto-flips status on the webhook.
- **E-signature** — accept is one-click. GHL splits this into a separate "Documents & Contracts" product with a legally-binding signature certificate (IP, geo, timestamps per signer); v3 territory if buyers ask for it.
- **Quote templates** (save & reuse) — every quote is built fresh in v1. Easy v2 add — extend the new-quote flow to optionally seed from a saved template.
- **Multiple recipients per quote** — single `contactId`. v2 if it comes up.
- **Per-line tax rates** — single global tax % in v1. Per-line is GHL parity but a much bigger UI lift.
- **PDF email attachment** — email links to the public page; PDF rendered there on demand if needed. v2.
- **SMS-send option** — email-only for v1. The Twilio wrapper exists; v2 just adds a "Send via SMS" alternative.
- **Quote-triggered automations actually firing sends** — see the `fireQuoteTrigger` caveat above. Type plumbing is in place; recipe support is the v2 piece.

## Setup contract

No new env vars. Reuses `RESEND_API_KEY` + `EMAIL_FROM` (email send), `AUTOMATIONS_TOKEN_SECRET` (HMAC token signing), Firebase (storage), `NEXT_PUBLIC_APP_URL` (public URL construction). The buyer who clones LeadStack and follows the existing Phase 3 onboarding gets Quotes working out of the box — fits inside the existing Resend setup step. Graceful degradation: if Resend isn't configured, the builder still works locally (create / edit / save drafts), the Send button just returns 503 with a friendly "Configure Resend to send quotes" message.

