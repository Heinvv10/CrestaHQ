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
- **Operator reschedule** — `POST /api/events/by-id/[id]/reschedule` (member-authenticated) moves a booking-page event's time through [src/lib/booking/reschedule.ts](../../src/lib/booking/reschedule.ts)'s `rescheduleWithoutAvailabilityCheck` + `runRescheduleSideEffects` — the identical stamps/trigger/reminder-reschedule/visitor-email bookkeeping as the public token endpoint, minus the availability re-check (an operator is trusted to have picked a sane time, same as GHL). Refused with `409` unless the booking still holds a slot (`scheduled`/`awaiting_payment`) and its booking page still exists, and with `400 no_change` when the time is unchanged — none of which rotates the token. The response carries `notifyEmailSent` + `notifyEmailSkipReason` (same vocabulary as mark-status) because the token rotation kills the visitor's old manage link: if the "Updated:" email didn't go out, the dialog says so. The calendar event dialog routes a changed time on a booking-page event through this endpoint *before* writing any other field, so a refused reschedule saves nothing; the time inputs are disabled on cancelled/completed/no-show bookings. Booking-page events are not exposed on the v1 API (see [public-api.md](public-api.md)).

## Paid-booking flow

Pages with `priceCents > 0` mint a `holdUntil` window on the event at book time. The recipient sees a "Pay to confirm" CTA → PayPal.me link (reuses Products + Invoices' `lib/paypal/payment-link.ts`). An operator clicks **Mark paid** in the dashboard to flip the event to confirmed. `/api/events/payment/expire-step` is a QStash callback that auto-cancels the hold when `holdUntil` lapses without payment — same lifecycle email path as a manual cancel, just with a `paymentExpired` reason.

## Lifecycle side-effects

[src/lib/booking/lifecycle.ts](../../src/lib/booking/lifecycle.ts) is the single helper that every state-changing booking route calls. It:
1. Writes a typed activity row to `contacts/{contactId}/activities` (`booking_page_booked`, `booking_payment_received`, `booking_cancelled`, `booking_rescheduled`, `booking_no_show`, `booking_completed`).
2. Dispatches into `fireBookingTrigger()`, which maps the (legacy-named) `event_*` trigger literal to the matching Workflow Builder `booking.*` trigger type — `event_booked→booking.created`, `event_cancelled→booking.cancelled`, `event_rescheduled→booking.rescheduled`, `event_paid`/`event_confirmed→booking.confirmed`, `event_completed→booking.showed`, `event_no_show→booking.no_show` — and always passes `{eventId, bookingPageSlug}` as trigger context so a workflow can pin itself to one booking page (see [docs/features/workflows.md](workflows.md)).
3. Returns the lifecycle outcome so the calling route can include it in the response body.

## Status lifecycle

`EventStatus` is unchanged (`scheduled | awaiting_payment | completed | cancelled | no_show`); only the operator-facing labels use GHL's vocabulary, via the single `eventStatusLabel()` helper in [src/types/events.ts](../../src/types/events.ts): `scheduled` → **Confirmed**, `awaiting_payment` → **Unconfirmed (awaiting payment)**, `completed` → **Showed**, `no_show` → **No-show**, `cancelled` → **Cancelled**.

`POST /api/events/by-id/[id]/mark-status` (and the v1 API's `status` PATCH, via the shared [src/lib/server/event-status-service.ts](../../src/lib/server/event-status-service.ts)) allows: `scheduled` → `completed`/`no_show`/`cancelled`; `completed` ↔ `no_show` as a correction either direction (re-fires the matching `booking.showed`/`booking.no_show` trigger each time); `cancelled` is always final. `awaiting_payment` only exits via mark-paid.

**Decision: mark-status applies identically to manual (non-booking-page) calendar events with a linked contact.** There is no separate code path — a manual event's `bookingPageSlug` is `null`, so it fires `booking.showed`/`booking.no_show`/`booking.cancelled` with `bookingPageSlug: null` in the trigger context, which a page-filtered workflow never matches (only an unfiltered one fires). This was a deliberate scope decision, not an oversight.

## Setup contract

**No new env vars.** Reuses `RESEND_API_KEY` + `EMAIL_FROM` (confirmations), `AUTOMATIONS_TOKEN_SECRET` (HMAC for the public reschedule/cancel tokens), `QSTASH_*` (reminder + payment-expiry schedules), `NEXT_PUBLIC_APP_URL` (public URL construction). Booking pages are public so `/b` + `/api/booking` are in middleware's `PUBLIC_PATHS`. Reuses the per-sub-account dedicated sending domain when configured — confirmation emails go out from the tenant brand.

