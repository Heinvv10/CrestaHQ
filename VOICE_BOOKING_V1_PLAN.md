# Voice Booking v1

> Status: **BUILT 2026-07-22** (typecheck + lint clean; NOT yet
> runtime-verified on a live Vapi call — verify by setting a booking page
> in Voice settings, calling in, and booking a slot end-to-end; confirm
> the event lands on the calendar and a stale slot gets a graceful
> "just taken" recovery). Picks as locked: (1) phone-only booking (page
> email requirement + intake fields waived; confirmation email + reminders
> skipped — both are email-based), (2) slot horizon = next 7 days capped by
> the page's visibleDays, (3) straight to shipped (per-workspace opt-in via
> the booking-page picker in Voice settings).
>
> **Architecture note (deviation from the proposal, simpler):** no Vapi
> tool registration and no new webhook route. Because the voice channel
> runs custom-LLM mode, WE are the model — booking is a marker-interception
> loop inside the existing LLM webhook (`[[slots]]` / `[[book …]]` markers
> the model emits, intercepted before TTS, executed against
> `lib/server/voice-booking-service.ts`, result fed back for the spoken
> reply; ≤2 tool rounds per turn). Existing assistants get booking with
> ZERO re-provisioning, and `stripVoiceUnspeakables()` guarantees markers
> can never be spoken. The service reuses the public booking route's exact
> building blocks (computeAvailability/union, host assignment, token mint,
> lifecycle helpers) so voice can't disagree with the public page.

## Goal

The inbound Voice AI can **book a real appointment during the call** —
check live availability on one of the sub-account's native booking pages,
offer slots verbally, and confirm the booking — instead of only promising
a callback. GHL-parity feature; the building blocks all exist.

## Why it's well-scoped

Everything below the Vapi layer already ships:

- `lib/booking/availability.ts::resolveAvailability()` — live slot
  resolution for a page.
- The book transaction behind `POST /api/booking/[saId]/[slug]/book` —
  transactional slot re-verify, contact reconciliation, Event mint,
  ICS confirmation email, reminders via QStash, lifecycle activity +
  workflow triggers. Voice booking calls the same service, so a
  voice-booked appointment behaves identically to a web-booked one.
- Phone-first contact reconciliation (caller ID) — same strategy the
  end-of-call handler uses.
- The `{{bookingLink}}` prompt injection (shipped 2026-07-21) already
  teaches the agent to promise the link by text; booking tools upgrade
  that promise to a live booking.

## Architecture

1. **Two Vapi tools** registered on the assistant at provisioning time
   (`lib/comms/voice/vapi.ts::buildAssistantBody`), using Vapi's
   function-calling with a server URL:
   - `check_availability({ dayOffset?: number })` → next available slots
     (capped at 3 per call — verbal lists longer than 3 don't work).
   - `book_slot({ slotStartIso: string, name: string, email?: string })`
     → books it for the caller.
2. **One new webhook route** `POST /api/webhooks/vapi/tools/[subAccountId]`
   — same `?s=` secret model as the existing three Vapi routes; added to
   middleware public paths. Translates Vapi's tool-call payload into
   calls on the existing booking services and returns the tool result
   Vapi speaks from.
3. **Channel config** — `voice.bookingPageSlug: string | null` on the
   voice channel doc. A dropdown of this sub-account's **published**
   booking pages in the Voice settings UI ("Let the agent book
   appointments on: [page]"). Null (default) = feature off, assistant is
   provisioned WITHOUT the tools, behavior identical to today.
4. **Prompt** — when a booking page is wired, the voice booking block
   switches from "promise the link by text" to slot-offering guidance
   (offer ≤3 slots, confirm date+time back phonetically, get the name
   before booking — reuses the existing capture-trigger flow).

## Guards / correctness

- **Idempotency**: the existing book transaction re-verifies the slot is
  free; a Vapi tool-call retry can't double-book — second attempt returns
  "slot taken", agent offers the next one.
- **Timezone**: slots are offered in the booking page's timezone, spoken
  explicitly ("ten a.m. Sydney time") — same source of truth as the page.
- **Paid pages** (`priceCents > 0`): v1 REFUSES — the deposit/hold flow
  doesn't fit a phone call. Tool responds "this booking type needs a
  deposit", agent falls back to the text-the-link promise.
- **Failure fallback**: any tool error → agent falls back to today's
  behavior (capture + team follow-up). A booking failure can never
  strand the caller.
- **Gates**: rides the existing voice channel gates (agency gate +
  channel enabled + Vapi configured). No new agency gate — booking is a
  capability of the already-gated voice channel, opted into per
  sub-account by picking a page.

## Explicitly deferred (v2+)

- Reschedule / cancel by voice.
- Paid/deposit bookings by voice.
- Multi-page choice mid-call ("do you want a 15 or 30 minute slot").
- Outbound-call booking (compliance posture differs; v1 is inbound only).
- Auto-SMS of the confirmation/booking link after the call (the ICS
  email already goes out when an email was captured).

## Setup contract

**No new env vars.** Reuses `VAPI_API_KEY` + `VAPI_WEBHOOK_SECRET`,
`NEXT_PUBLIC_APP_URL`, the existing booking stack (Resend for
confirmations, QStash for reminders). Existing assistants pick up the
tools on the operator's next Voice settings save (the standard
re-provision path). No Firestore rules changes (voice channel doc is
already server-only).

## Effort

~2–4 days: tool registration + webhook route + settings dropdown +
prompt block + manual test loop over a live Vapi call.

## Open picks (decide before locking)

1. **Email on voice bookings** — booking pages can mark email required.
   v1 options: (a) agent asks for email verbally when the page requires
   it (spelling emails by phone is error-prone), or (b) voice bookings
   waive the email requirement and book with phone only (recommended —
   confirmation email simply skipped, reminder SMS could cover it later).
2. **Slot horizon** — how far out the agent offers (default proposal:
   next 7 days).
3. **Ship in Labs first?** — could ride the `labsEnabledByAgency` gate
   for a cohort test before general availability, like the watchdog.
