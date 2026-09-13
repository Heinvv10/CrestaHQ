# Booking pages v1

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

Native Calendly-style slot picker per sub-account. The operator configures a Booking Page (durations, working hours, optional price, optional reminder offsets) and shares the public URL `/b/[subAccountId]/[slug]`. A visitor picks a slot, the server transactionally re-verifies availability, reconciles a Contact, mints an Event, and sends an ICS-attached confirmation email. Reschedule + cancel + reminders + payment-expiry are all queued through QStash so they keep firing across Vercel cold starts.

## Data model

- `subAccounts/{id}/bookingPages/{pageId}` — page config (slug, timezone, duration, padding, working hours, required fields, optional `priceCents`, optional `reminderOffsetMinutes[]`, `status: "draft" | "published"`).
- `subAccountDoc.bookingLink` — the sub-account's **default booking link**: the URL the `{{bookingLink}}` merge tag resolves (workflows, broadcasts, WhatsApp templates, review requests) AND the link the AI agents share when someone wants to book (`buildSystemPrompt`'s channel-aware booking block — text channels share the URL, voice promises it by text). Set by admins via the **Default booking link** card on the Booking page ([src/components/booking/default-booking-link-card.tsx](../../src/components/booking/default-booking-link-card.tsx)) — pick a published booking page or paste a custom URL (Calendly etc.); saves through the existing sub-account PATCH. (The original setter died with the legacy Automations → Settings page — until this card, the tag silently resolved to "".)
- `events/{eventId}` — the existing Calendar events collection picks up two new optional fields: `bookingPageId` (denormalised back-reference) + `bookingMeta` (the recipient-typed payload + ICS uid).
- Token: bookings mint a public `bookingEventToken` HMAC-signed via `AUTOMATIONS_TOKEN_SECRET`, used in confirmation-email links so the recipient can reschedule or cancel without a login. The raw token never persists — only the SHA-256 hash on the event doc.

## Calendar types (SP3)

A page's `calendarType` (absent on legacy pages ⇒ `pageCalendarType()` derives `round_robin` when it has hosts, else `personal`):

| Type | Slots | Booking |
|---|---|---|
| `personal` | One host: that host's events + unassigned events block. No host: every event in the sub-account blocks (legacy single schedule) | Stamps the host |
| `round_robin` | Union of each host's free time | One host: `distribution` `equal` (least loaded, then `priority`) or `availability` (priority, then load); page order last |
| `collective` | Intersection — every host free (each host's own hours) | Every host: `hostUids[]`, `assignedToUid` = first. Blocks each listed host everywhere |
| `class` | Same-page bookings at the slot start are seats (`seatsPerSlot` ≥2); the day cap counts offered slots after full ones drop | One event per attendee. A hostless class page's seats carry no host, so each one is shared busy — it blocks every host's other pages for that time |
| `service` | Sized to the picked service (`services[]`, 1–20) | As round robin; stamps `serviceId`/`serviceName` |

Every caller that offers or re-verifies a slot — availability API, book route and reschedule route (inside their transactions), voice agent — goes through `resolvePageAvailability` ([src/lib/booking/resolve-availability.ts](../../src/lib/booking/resolve-availability.ts)); the rules are pure in [page-slots.ts](../../src/lib/booking/page-slots.ts). Reschedule re-verifies the event as it was booked (`MovingEvent`): all of its own host(s) — one no longer on the page keeps the page hours while still an active member, and is refused with a 409 ("… is no longer available — please contact the business to rebook") once they are not — its service, or its own length when that service is gone. A hostless booking on a page that has since gained hosts keeps the legacy shared schedule (every event blocks). The reschedule view's `excludeEventId` is honoured only for an event booked on that page. Voice refuses service pages (no service step on a call).

**Rollout:** the host readers (per-host `.ics` feed, round-robin load, reassign conflict check) query `events(subAccountId, hostUids CONTAINS, startAt)` through `queryHostEvents`. Deploy `firestore.indexes.json` and let that index finish building BEFORE shipping this code; until it does, the collective half of each read fails (logged) and only owned bookings are seen.

## Availability rules (SP3)

All optional; absent ⇒ the old behaviour. Applied in [page-slots.ts](../../src/lib/booking/page-slots.ts) / [availability.ts](../../src/lib/booking/availability.ts), so every caller of the resolver gets them.

- **Date-specific hours** — `dateOverrides[]` (`{date: "YYYY-MM-DD", ranges}`, page timezone) on the page and per host. Empty `ranges` = closed that date; an entry can also open a date the weekly hours leave closed. Precedence for one host on one date: a page entry that **closes** the date closes it for everyone; otherwise the host's own entry wins; otherwise a page entry that changes hours applies — but only to hosts on the page hours (a host with custom weekly hours keeps them); otherwise weekly hours. Max 366 per list; past dates are kept.
- **Buffers** — `bufferBeforeMinutes` (new) and `bufferMinutes` (now the *after* buffer). A new slot `[S, E)` must have `[S − before, E + after)` clear of every busy interval (manual events, other pages' bookings, external busy). This page's own bookings also keep their buffers, so two bookings on the same page are at least `max(before, after)` apart.
- **Slot interval** — `slotIntervalMinutes` (5–240, step 5): minutes between slot starts, across services too. Null ⇒ `durationMinutes + bufferMinutes`, the old step.

**Behaviour change for existing pages:** before SP3 `bufferMinutes` was only the slot step and never padded existing events — a 15-min buffer still allowed a slot starting right when a manual event ended. It now pads busy time as the after-buffer. Slots next to the page's own on-grid bookings are unchanged (the step already leaves that gap); a slot whose after-buffer runs into an off-grid manual event, or a same-page booking closer than the buffer, is no longer offered.

## Send flow

1. **Public page** (`/b/[subAccountId]/[slug]`) — server-renders the page config; the client fetches slots from the availability endpoint below.
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

