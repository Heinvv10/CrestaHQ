# Booking pages v1

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

Native Calendly-style slot picker per sub-account. The operator configures a Booking Page (durations, working hours, optional price, optional reminder offsets) and shares the public URL `/b/[subAccountId]/[slug]`. A visitor picks a slot, the server transactionally re-verifies availability, reconciles a Contact, mints an Event, and sends an ICS-attached confirmation email. Reschedule + cancel + reminders + payment-expiry are all queued through QStash so they keep firing across Vercel cold starts.

## Data model

- `subAccounts/{id}/bookingPages/{pageId}` — page config (slug, timezone, duration, padding, working hours, required fields, optional `priceCents`, optional `reminderOffsetMinutes[]`, `status: "draft" | "published"`).
- `subAccountDoc.bookingLink` — the sub-account's **default booking link**: the URL the `{{bookingLink}}` merge tag resolves (workflows, broadcasts, WhatsApp templates, review requests) AND the link the AI agents share when someone wants to book (`buildSystemPrompt`'s channel-aware booking block — text channels share the URL, voice promises it by text). Set by admins via the **Default booking link** card on the Booking page ([src/components/booking/default-booking-link-card.tsx](../../src/components/booking/default-booking-link-card.tsx)) — pick a published booking page or paste a custom URL (Calendly etc.); saves through the existing sub-account PATCH. (The original setter died with the legacy Automations → Settings page — until this card, the tag silently resolved to "".)
- `events/{eventId}` — the existing Calendar events collection picks up two new optional fields: `bookingPageId` (denormalised back-reference) + `bookingMeta` (the recipient-typed payload + ICS uid).
- Token: bookings mint a public `bookingEventToken` HMAC-signed via `AUTOMATIONS_TOKEN_SECRET`, used in confirmation-email links so the recipient can reschedule or cancel without a login. The raw token never persists — only the SHA-256 hash on the event doc.

## Send flow

1. **Public page** (`/b/[subAccountId]/[slug]`) — server-renders the page config + the next ~14 days of available slots from `lib/booking/availability.ts::resolveAvailability()`.
2. **POST `/api/booking/[saId]/[slug]/availability`** — recipient-facing availability re-check (per-IP rate-limited). Used by the date picker when the visitor lands.
3. **POST `/api/booking/[saId]/[slug]/book`** — the actual booking transaction. Validates the inbound payload, re-verifies the slot is still free, reconciles a Contact via `lib/booking/contact-reconcile.ts` (email-first match, falls back to phone, otherwise creates a `source: "booking"` Contact), mints the Event, and triggers the lifecycle pipeline.
4. **Confirmation email** (`lib/booking/email.ts` + `lib/booking/ics.ts`) — sends through the sub-account's verified sending domain via `tenantFrom(sub)`. The ICS attachment uses an opaque uid per event so calendar updates (`METHOD:REQUEST` on book, `METHOD:CANCEL` on cancel) chain correctly in Gmail/Outlook.

## Reschedule + cancel

- `/api/events/[token]/reschedule` and `/api/events/[token]/cancel` — anonymous endpoints, token IS the credential. Each transactionally moves or kills the event, re-mints the ICS uid, and fires the matching lifecycle email + activity entry.
- `/api/events/reminder/step` — QStash callback for each configured reminder offset. Pulls the live event (so a reschedule cancels stale reminders), checks the booking page's `reminderOffsetMinutes[]`, and sends if still valid.

## Paid-booking flow

Pages with `priceCents > 0` mint a `holdUntil` window on the event at book time. The recipient sees a "Pay to confirm" CTA → PayPal.me link (reuses Products + Invoices' `lib/paypal/payment-link.ts`). An operator clicks **Mark paid** in the dashboard to flip the event to confirmed. `/api/events/payment/expire-step` is a QStash callback that auto-cancels the hold when `holdUntil` lapses without payment — same lifecycle email path as a manual cancel, just with a `paymentExpired` reason.

## Lifecycle side-effects

[src/lib/booking/lifecycle.ts](../../src/lib/booking/lifecycle.ts) is the single helper that every state-changing booking route calls. It:
1. Writes a typed activity row to `contacts/{contactId}/activities` (`event_booked`, `event_rescheduled`, `event_cancelled`, `event_paid`, `event_payment_expired`).
2. Dispatches into `fireTriggers()` with the matching `AutomationTriggerType` — so the booking events appear alongside form-submit, quote-accept, etc. in the automation engine. (Same caveat as Quotes: the v1 `instant_response` recipe doesn't handle these triggers yet; the dispatch plumbing is in place, recipe support is the missing piece.)
3. Returns the lifecycle outcome so the calling route can include it in the response body.

## Setup contract

**No new env vars.** Reuses `RESEND_API_KEY` + `EMAIL_FROM` (confirmations), `AUTOMATIONS_TOKEN_SECRET` (HMAC for the public reschedule/cancel tokens), `QSTASH_*` (reminder + payment-expiry schedules), `NEXT_PUBLIC_APP_URL` (public URL construction). Booking pages are public so `/b` + `/api/booking` are in middleware's `PUBLIC_PATHS`. Reuses the per-sub-account dedicated sending domain when configured — confirmation emails go out from the tenant brand.

