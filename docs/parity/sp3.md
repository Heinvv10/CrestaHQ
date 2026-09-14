# SP3 — Calendars & booking

**Date:** 2026-09-13 · **Status: (a)–(e) merged (#109 #110 #107 #115 #116, + #120 test guard); (f) #119 merged — all SP3 build PRs on `main`; R1/R2 done; deployed 2026-09-14 08:57 SAST at `d0c3893`** · **Depends on:** SP0 (merged) · **Blocks:** SP11 (appointment reports), SP14.
Programme context: [PARITY_PROGRAM.md](../PARITY_PROGRAM.md) §SP3. Model ledger: [sp1.md](sp1.md). Feature spec: [booking-pages.md](../features/booking-pages.md).

Proving tenant: **#1000 CrestaHQ** (`subAccounts/54vPI0BS1zDMcxMyMAyA`) and the E2E fixture tenant. Never Blitz/Velocity/Vortex.

Definition of done per row: Playwright spec in `e2e/specs/` (mutation-proven, blocking CI) + blind review APPROVED + shown in the browser with a screenshot under `docs/parity/evidence/sp3/`.

---

## Vocabulary

A GHL **calendar** is a LeadStack **booking page** (`subAccounts/{id}/bookingPages/{slug}`). A GHL **appointment** is a LeadStack **event** (`events/{id}`). The ledger uses GHL's words in the GHL column and LeadStack's in the rest. Nothing is renamed in storage.

## Ledger

Columns: GHL behaviour (observed 2026-09-13 in the CrestaHQ location `jEr9SOZnEyVsi8oK2Vnj`, screenshots in `evidence/sp3/ghl/`) · LeadStack today (code at `cb1323b`, browser on #1000 2026-09-13, `evidence/sp3/before/`) · Gap · PR · Spec · Status.

Rows marked ⚠ were not exercised in GHL: its calendar editor stopped responding to clicks on **Booking rules** and **Advanced settings** during the session, so those rows come from GHL's field names as shown elsewhere, not from the panel itself.

### Calendar types

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| K1 | **Choose calendar type** dialog: Personal booking · Round robin · Class booking · Collective booking · "Explore more types" (`ghl/02`) | One page shape. No type field; "Hosts / team" section flips a page into team mode (`types/booking.ts:129`) | `calendarType` on the page, chosen in a type picker on **New booking page**; absent ⇒ derived (hosts ⇒ `round_robin`, else `personal`) so every existing page keeps its behaviour | (a) #109 | `calendar-types.spec.ts` | **merged** · [evidence/sp3/k-types/](evidence/sp3/k-types/) |
| K2 | **Personal**: one team member's calendar | Hostless page = "single shared schedule": every event in the sub-account blocks it | `personal` with exactly one host: only that host's events (+ unassigned shared events) block; booking stamps the host. Hostless legacy pages unchanged | (a) #109 | same | **merged** · [evidence/sp3/k-types/](evidence/sp3/k-types/) |
| K3 | **Round robin**, *Meeting distribution*: **Optimize for availability** / **Optimize for equal distribution**; per-staff **Priority** (High/Medium/Low) (`ghl/03`) | Team mode = union availability + least-loaded assignment (`hosts.ts:135`), no priority, no mode | `distribution: "availability" \| "equal"` + `priority` per host. *availability*: highest-priority free host, ties → least loaded. *equal*: least loaded, ties → priority. Both then page order | (a) #109 | same | **merged** · [evidence/sp3/k-types/](evidence/sp3/k-types/) |
| K4 | **Collective**: multiple hosts meet one participant — slot open only when **all** are free | None | `collective`: intersection of host availability; event carries `hostUids[]`; every listed host is busy for that event everywhere else | (a) #109 | same | **merged** · [evidence/sp3/k-types/](evidence/sp3/k-types/) |
| K5 | **Class**: one host, multiple participants per slot | None | `class` + `seatsPerSlot` (≥2): slot stays offered until that many bookings share its start; each attendee is their own event (lifecycle, reminders, links per attendee); public page shows seats left | (a) #109 | same | **merged** · [evidence/sp3/k-types/](evidence/sp3/k-types/) |
| K6 | **Service calendars (v1)** tab: a menu of services, each with its own duration and staff | None | `service` + `services[]` (`{id, name, durationMinutes, description}`): visitor picks a service, then a slot sized to it; event stores `serviceId`/`serviceName`; hosts assign as round robin | (a) #109 | same | **merged** · [evidence/sp3/k-types/](evidence/sp3/k-types/) |
| K7 | Calendar list: name, group, duration, type, status, updated; filters Status/Type/Owned by; **Groups** (`ghl/01`) | Cards: name, status, duration, tz, URL (`evidence/sp3/before/01`) | Type badge on each card. Groups and list filters not built (see "Not building") | (a) #109 | same | **merged** · [evidence/sp3/k-types/](evidence/sp3/k-types/) |

### Availability and booking rules

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| A1 | Weekly working hours, multiple ranges per day, per-user **schedule** with its own timezone (`ghl/05`) | Page `workingHours` (multi-range) + page `timezone`; per-host hours override (`BookingHost.workingHours`) | — | — | — | parity |
| A2 | **Date specific hours**: override weekly hours or mark a date unavailable (`ghl/05`) | None | `dateOverrides[]` (`{date: "YYYY-MM-DD", ranges: [...]}`; empty ranges = closed) on the page and per host; an override replaces that weekday's hours for that date only | (b) #110 | `availability-rules.spec.ts` | **merged** · [evidence/sp3/a-availability/](evidence/sp3/a-availability/) |
| A3 | ⚠ Pre- and post-meeting **buffer** | One `bufferMinutes`, used only as the slot step (`availability.ts:173`). It does **not** pad existing bookings: a manual 10:00–10:30 event with a 15-min buffer still allows a 10:30 slot | `bufferBeforeMinutes` + existing `bufferMinutes` as after-buffer; both pad every busy interval (including Google busy from D2) | (b) #110 | same | **merged** · [evidence/sp3/a-availability/](evidence/sp3/a-availability/) |
| A4 | ⚠ **Minimum scheduling notice** | `minNoticeHours` | — (hours only; GHL also offers minutes/days — not building) | — | — | parity |
| A5 | ⚠ **Max bookings per day** | `maxPerDay` (per host in team mode) | — | — | — | parity |
| A6 | ⚠ **Slot interval** separate from duration | Step is always `duration + buffer` | `slotIntervalMinutes`; null ⇒ today's `duration + buffer`, so existing pages offer the same slots | (b) #110 | same | **merged** · [evidence/sp3/a-availability/](evidence/sp3/a-availability/) |
| A7 | ⚠ Date range (how far ahead) | `visibleDays` | — | — | — | parity |
| A8 | Every place a slot is offered or re-verified obeys the same rules | **Five** separate callers of `computeAvailability`: availability route, book route (×2), reschedule route, voice service (×3). The **reschedule route ignores team mode** (`reschedule/route.ts:164`): page hours only, and every host's events block | One server resolver (`resolvePageAvailability`) that loads busy, applies type/host/override/buffer/Google rules, and is the only thing the five callers use. Fixes team-mode reschedule | (a) #109 | `calendar-types.spec.ts` reschedules a team booking | **merged** · [evidence/sp3/a-availability/](evidence/sp3/a-availability/) |

### Appointment status lifecycle

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| S1 | Statuses **Confirmed · Cancelled · Showed · No-show** (+ Unconfirmed, Invalid) | Stored `scheduled`, `awaiting_payment`, `completed`, `cancelled`, `no_show` (`types/events.ts:15`) | UI labels: `scheduled` → **Confirmed**, `completed` → **Showed**, `awaiting_payment` → **Unconfirmed (awaiting payment)**. Stored values unchanged. Invalid not built | (c) #107 | `appointment-status.spec.ts` | **merged** · [evidence/sp3/s-status/](evidence/sp3/s-status/) |
| S2 | Status can be changed from the appointment, including correcting Showed ↔ No-show | `mark-status` route: from `scheduled` only; every terminal state is final (`mark-status/route.ts:83`) | Allow `completed` ↔ `no_show` corrections; `cancelled` stays final (rebook instead) | (c) #107 | same | **merged** · [evidence/sp3/s-status/](evidence/sp3/s-status/) |
| S3 | Workflow trigger **Appointment Status** (filter by calendar + status), **Customer Booked Appointment** | Triggers `booking.created`, `booking.cancelled`, `booking.rescheduled` (`workflows/catalog.ts:18`). No-show and completed fire **no** trigger (`mark-status/route.ts:187`) | New triggers `booking.confirmed` (free booking, and mark-paid), `booking.showed`, `booking.no_show`; every booking trigger gains an optional booking-page filter | (c) #107 | same + workflow run asserted | **merged** · [evidence/sp3/s-status/](evidence/sp3/s-status/) |
| S4 | Rescheduled shows on the appointment | Reschedule moves the same event doc (`reschedule/route.ts:179`) and fires `booking.rescheduled`; nothing on the doc says it moved | `rescheduledAt` + `rescheduleCount` on the event; "Rescheduled" badge. Rescheduled is a transition, not a stored status (GHL has no such status either) | (c) #107 | same | **merged** · [evidence/sp3/s-status/](evidence/sp3/s-status/) |

### Google Calendar sync

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| G1 | **Connections**, per staff member: connected calendars (Google/Outlook), **Linked calendar** (where bookings are written), **Conflict calendars** (checked to prevent double booking) (`ghl/06`) | Read-only `.ics` subscription feed (`calendar-sync-section.tsx`); Google OAuth exists **per sub-account for GBP only** (`business.manage`, `private/googleConnection`) | Per-member Google Calendar connection: `calendar.events` scope on the existing OAuth client, own token doc per member, connect/disconnect on Settings → Calendar sync. Linked = conflict = **primary** calendar (a calendar picker needs the `calendarlist` scope — not requested) | (d) #115 | `google-calendar-sync.spec.ts` (fake provider) | **merged** · [evidence/sp3/g-gcal/](evidence/sp3/g-gcal/) |
| G2 | Busy time in conflict calendars blocks slots | — | Resolver (A8) reads each host's Google busy (`events.list`, singleEvents, skipping transparent/cancelled and events LeadStack itself pushed) for the window, and again at book-time re-verify | (d) #115 | same | **merged** · [evidence/sp3/g-gcal/](evidence/sp3/g-gcal/) |
| G3 | Bookings appear in the linked calendar and follow reschedules/cancels | — | Insert on book, patch on reschedule, delete on cancel, into each assigned host's primary calendar; `googleEventIds` on the event | (d) #115 | same | **merged** · [evidence/sp3/g-gcal/](evidence/sp3/g-gcal/) |
| G4 | Connection survives token expiry; broken connection is visible | — | Refresh-token exchange with cached access token; `invalid_grant` marks the connection `revoked` and the card says Reconnect | (d) #115 | same | **merged** · [evidence/sp3/g-gcal/](evidence/sp3/g-gcal/) |
| G5 | Outlook calendar connection — **what Hein actually uses in GHL today** (`hein@blitzfibre.com`, `hein@velocityfibre.co.za`, `ghl/06`) | — | Not in this goal (goal names Google). Recorded so it is a decision, not an oversight | — | — | out of scope |

### Booking widget and confirmations

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| W1 | Share button → booking link + **embed code** (iframe) for any website; `/widget/bookings/<slug>` | Public page `/b/[saId]/[slug]`, not framable (only `/embed/*` sends `frame-ancestors *`, `next.config.ts:19`) | `/embed/booking/[saId]/[slug]` (chrome-less public view, inherits the framable headers) + `booking-embed.js` loader that injects the iframe and auto-sizes it via `postMessage`; **Embed** dialog on the booking page with copyable snippet | (e) #116 | `booking-widget.spec.ts` | **merged** · [evidence/sp3/w-widget/](evidence/sp3/w-widget/) |
| W2 | Confirmation and reminder emails carry reschedule / cancel links | Present in confirmation + reminder (`email.ts:100,273`) → `/e/[token]` | Spec proves the link from a real booking opens `/e/[token]` and that reschedule and cancel both work from it | (e) #116 | same | **merged** · [evidence/sp3/w-widget/](evidence/sp3/w-widget/) |

### Appointments list

| # | GHL | LeadStack today | Gap | PR | Spec | Status |
|---|---|---|---|---|---|---|
| L1 | **Appointment list view** next to Calendar view: tabs Upcoming · Cancelled · All; columns #, Title, Contact, Status, Appointment time, Calendar, Appointment owner; search by title (`ghl/08`) | Month grid only (`evidence/sp3/before/02`); per-page "View bookings" | `/sa/[id]/calendar/appointments` with a Calendar / Appointments switch; same tabs, columns and search (title + contact name) | (f) #119 | `appointments-list.spec.ts` | **merged** · [evidence/sp3/f-appointments/](evidence/sp3/f-appointments/) |
| L2 | **Advanced filters**: Calendar, User, Status, Date added, Appointment time, Source, Contact (`ghl/09`) | — | Filters: booking page, host, status, appointment-time range, source (booking page / manual / voice). Date added and saved smart lists not built | (f) #119 | same | **merged** · [evidence/sp3/f-appointments/](evidence/sp3/f-appointments/) |
| L3 | Status change from the list | — | Row menu → mark status (reuses S2 route) | (f) #119 | same | **merged** · [evidence/sp3/f-appointments/](evidence/sp3/f-appointments/) |

### Runtime verification (no build unless something is broken)

| # | Item | Today | Plan | Status |
|---|---|---|---|---|
| R1 | Voice booking | "built, unverified" (`voice-booking-service.ts`) | Drive a real booking through the Vapi tool path against #1000 and record what actually happens | **proven live on production 2026-09-14** (real model via the production webhook; audio leg not exercised) — see below |
| R2 | Reminders fire from QStash | Scheduled at book time (`lifecycle.ts:222`) | Book a slot on #1000 whose T-1h reminder falls inside the session; show the QStash message and the email delivery | **proven 2026-09-13** — see below |

**R1 — what actually happened (2026-09-13).**
- **Production cannot take a voice call at all.** In the running `crestahq` process, `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_PUBLIC_BASE_URL` and `OPENROUTER_API_KEY` are present but empty. `/api/webhooks/vapi/llm/[id]` therefore returns 401 to every request (`authorize()` needs a non-empty secret), and `callAi()` throws "OPENROUTER_API_KEY is not set". This is wider than voice: no AI reply on any channel can run on crm.crestahq.com. #1000 also has no `aiAgent/*` config. Fixing it needs Hein's OpenRouter key and Vapi credentials.
- **The booking code path works.** Tested with `origin/main` `371e163`, built locally, running against production Firestore for #1000. QStash, mail and SMS were disabled, and only the LLM was replaced, by a scripted responder that emits the same markers the real model is told to. A temporary voice agent and a temporary published page were used; both have since been deleted. What happened:
  - The webhook received the caller turn. The model emitted `[[slots]]`.
  - The service returned busy-aware slots. It left out 12:30, which the R2 probe had already booked, and anything inside min notice.
  - The model emitted `[[book start=… name="Voiceprobe"]]`, and the book ran in a transaction.
  - It created event `FydMl3Zh9eAlOtU7bKEs`: `scheduled`, `booking_page`, notes "Booked by phone via the AI voice agent".
  - It created a contact matched on caller-ID phone (`source: voice`) and a `booking_page_booked` activity.
  - The confirmation was spoken. By v1 design, a voice booking sends no email and schedules no reminder.
  - Evidence: `evidence/sp3/runtime/r1-voice-marker-loop.txt` and `r1-r2-firestore.txt`.
- **Not exercised:** the telephony leg (Vapi to our webhook) and a real model's behaviour.

**R1 — live on production (2026-09-14).** Hein supplied an OpenRouter key and a Vapi private key. They went into `/home/velo/crestahq-config/.env.production` with a generated `VAPI_WEBHOOK_SECRET`; the file was backed up first and the service restarted. On #1000 the AI agent profile was saved and Voice enabled in the UI in "A number I own in Vapi" mode, on a free Vapi number (+1 949 704 8751). Live booking points at the `review-audit-call` page. Vapi confirmed the sync: assistant `58a9a9fd-…`, custom-LLM URL on crm.crestahq.com.
- Two caller turns went to the production LLM webhook exactly as Vapi sends them: `?s=` secret, OpenAI chat shape, caller ID +15555550123 (fictional). The real model is `anthropic/claude-haiku-4-5` via OpenRouter.
- **Turn 1** (200 in 5.4 s): the agent offered three real free slots.
- **Turn 2** (200 in 6.2 s): the caller picked Thursday 09:20. The agent said "locked in".
- Firestore then held:
  - event `OSPtStDNvygpwKDwUWCs`, `scheduled`, `booking_page`, notes "Booked by phone via the AI voice agent";
  - a new contact with `source: voice` on the caller's number;
  - a `booking_page_booked` activity.
- The booking showed in the #1000 Appointments list (`evidence/sp3/runtime/r1-live-prod-appointments.jpg`). The probe event and contact were then deleted.
- Evidence: `evidence/sp3/runtime/r1-live-prod.txt`.
- **Still not exercised:** audio. Vapi's text-chat API needs a card on file, and its free US number can't dial out to South Africa, so a real phone call must come from Hein's handset to +1 949 704 8751. The Cloudflare user-agent question below is still open for Vapi's own requests.
- **Open risk:** Cloudflare returned `403 error code: 1010` to Python's default user agent on crm.crestahq.com. Whether it lets Vapi's webhook user agent through has not been checked.

**R2 — proven on #1000 (2026-09-13).**
- Published a temporary page. Booked 12:30 SAST through the real public page at 10:57, with the attendee address being one Hein controls.
- The book route published QStash message `msg_7YoJx…` for the T-1h offset, with `notBefore` 11:30:01. The T-24h offset was correctly skipped because it was already in the past.
- QStash log: `CREATED` 10:57:14 → `ACTIVE` 11:30:01 → `DELIVERED` 11:30:08, HTTP 200, to `https://crm.crestahq.com/api/events/reminder/step`.
- The "Reminder: … in 1 hour" email arrived at 11:30, after the 10:57 confirmation.
- Evidence: `evidence/sp3/runtime/r2-qstash-log.txt`, `r2-reminder-email-inbox.png` and `r2-probe-booked.jpg`.
- Probe page, events, contacts and conversation were deleted afterwards.
- Gap noted: a sent reminder leaves no trace in the CRM (no activity row), so an operator cannot see it happened. Candidate for a follow-up.
- Visual defect noted: the selected slot button on the public page renders blank.

---

## Build order and DAG

| PR | Scope | Rows | Depends on | Notes |
|---|---|---|---|---|
| (a) | `resolvePageAvailability` extraction (5 callers) + calendar types + team-mode reschedule fix | K1–K7 A8 | — | Largest; `review-team`. One reviewer hunts a caller that still computes availability on its own |
| (c) | Status labels, corrections, `booking.confirmed/showed/no_show` triggers, page filter, reschedule marker | S1–S4 | — | parallel with (a) (different files; both touch `types/events.ts` — (c) adds fields only) |
| (e) | Embed route + loader + dialog; reschedule/cancel link proof | W1 W2 | — | parallel |
| (b) | Date overrides, before/after buffers padding busy, slot interval | A2 A3 A6 | (a) | inside the resolver |
| (f) | Appointments list + filters + status menu | L1–L3 | (c) | |
| (d) | Google Calendar per-member connection, busy, push, refresh | G1–G4 | (a) (resolver), (c) (lifecycle hooks) | external setup: `calendar.events` scope + Calendar API on `crestahq-app` |

Runtime checks R1/R2 run against production as deployed today and need no PR unless they find a defect.

## Build log (2026-09-13 → 14)

| PR | Scope | Review rounds | Merged |
|---|---|---|---|
| #109 (a) | Resolver + calendar types + ledger + R1/R2 results | Four-reviewer team, then 3 fix rounds. Round 2 caught a HIGH the fix round itself introduced: an infinite slot loop from a member-written event length. | 85b1eae |
| #107 (c) | Status lifecycle + booking triggers | Four-reviewer team, then 4 fix rounds. The rounds caught: a v1 PATCH bypassing the transition rules; test-mode API keys firing live workflows (introduced by round 1); a retry dead end. | c3f52bb |
| #110 (b) | Date overrides, buffers, slot interval | Three-reviewer team, then 2 fix rounds. They fixed a **pre-existing** bug that made every booking 409 for UTC+12 or later zones (NZ, Tonga), and a pre-existing DST wall-time bug. Availability CPU dropped from 17 s to 1.7 s. | 0259149 |
| #116 (e) | Embeddable widget + W2 link fixes | Three-reviewer team, then 2 fix rounds. Fixed the anonymous reschedule/cancel 307 to /login and a stale token after reschedule. It also closed a **pre-existing live vulnerability**: middleware passed a client-supplied `x-user-uid` through on public paths, so `DELETE /api/forms/[id]` could be forged. | 8cdb7c7 |
| #115 (d) | Google Calendar two-way sync | Four-reviewer team, then 4 fix rounds. The team's security reviewer caught a colleague-calendar injection via a client-writable `assignedToUid`. The rounds also fixed invisible push failures, a push race, orphaned Google copies on delete, and removed-member PII. | f0e475a |
| #120 | Late-"now" regression tests + fail-fast window guard | 1 reviewer | bd58674 |
| #119 (f) | Appointments list | Two-reviewer team, then 4 fix rounds. Fixed: manual events could email contacts from the row menu; cancel had no confirmation; a timezone off-by-one in the date filter; completed / no-show could be set before the appointment started (dashboard and v1 API); a refused v1 PATCH still saved its other fields (introduced by round 3). | d0c3893 |

**Rules and indexes** were deployed from `main` after every merge that changed them. Each time the union was checked: no open PR carried a rules difference, except #111's deny-all, which is the same as the default. The `events` write locks were verified **live** with the client SDK against the fixture tenant: `hostUids` / `serviceId` / `serviceName` / `mode` / `googleEventIds` / `assignedToUid` / `source` / `bookingPageSlug` are refused on create and update, and a plain create, edit or delete is allowed. Note that the first probe after a release ran before propagation.

**Evidence:** screenshots under `evidence/sp3/{k-types,a-availability,s-status,g-gcal,w-widget,f-appointments}/`. They come from a local build of `main` driven by `e2e/evidence/sp3.capture.ts` on the **E2E fixture tenant**, with Google Calendar on the fenced fake provider. The deploy came after these were taken; a walk on #1000 with screenshots under `evidence/sp3/prod-1000/` is still open.

**Decisions taken during review** (the code is the source of truth; this records why):
- **Operator reschedule skips availability checks** (GHL parity). Visitor reschedule is always re-verified by the resolver.
- **Rescheduled is a marker** (`rescheduledAt` / `rescheduleCount`), not a status.
- **Test-mode API events** get the status write only, with no triggers or email.
- **Page closures are absolute.** A page-level change to opening hours skips hosts who have custom weekly hours.
- **Google:**
  - Disconnect never revokes at Google, because the OAuth client is shared with GBP.
  - Push targets the event's own active hosts (`assignedToUid` and `hostUids`, now server-locked).
  - Deleting a mirrored event goes through a server route, which refuses (409) if the Google copy can't be removed.
  - Push runs via `after()` on book and voice.
- **E2E-only `E2E_DISABLE_BOOKING_RATE_LIMITS=1`, fenced to a loopback app URL.** The whole suite runs from one client, so it exhausted the public booking rate limits. The deploy guard refuses the variable.

**Found outside SP3 scope, recorded:**
- **Production AI was dead until 2026-09-14.** `OPENROUTER_API_KEY` and all `VAPI_*` were empty on crm.crestahq.com. They were set on 2026-09-14 (see R1 live).
- **Forged identity header** (fixed in #116, deployed 2026-09-14). Proven on #1000 with a throwaway form: a session-less `DELETE /api/forms/<id>` with a forged `x-user-uid` returned 200 and deleted the form before the deploy, and returns 401 with the form intact after it.
- **Fixture pollution.** A spec leaving hostless events broke other booking specs in the evening. #119 fixes the leak; #120 makes the specs name the polluter.
- **The "E2E smoke (production)" workflow fails on every `main` push.** It runs `main`'s specs against crm.crestahq.com, which served pre-SP3 code until 2026-09-14, so the new specs (e.g. `booking-widget.spec.ts`) failed there. `workflow-enrol.spec.ts` also fails there with `Invalid signature` from the step worker; that failure was not investigated.

**Follow-ups (not blocking SP3):**
- `maxPerDay` is not enforced at book-time re-verify. This existed before SP3.
- The v1 events PATCH isn't atomic with a concurrent status change. This is documented.
- Manual Calendar-page edits of booking-page title/notes/location aren't pushed to Google.
- GBP disconnect still revokes at Google, which can drop a Calendar grant on the same Google account.
- The book-route rate limiter has no unit test.
- The E2E rate-limit fence could use the narrow loopback list.
- Removing a member: the 20 s copy-cleanup cap is untested, and bookings skipped at that cap aren't recorded.
- A sent reminder leaves no activity row.
- On service pages, the header still shows the page's default duration.
- Outlook calendar (G5).
- Google verification of the OAuth consent screen, needed before non-test users can connect Calendar.
- Cloudflare returns 1010 to non-browser user agents; whether that blocks Vapi's webhook is unverified.
- Mutation: the dialog's server-vs-client delete switch is untested at unit level.
- v1 PATCH resending an unchanged `completed` / `no_show` on an event whose start is in the future returns 409; the dashboard treats it as a no-op.
- The documented case "mark completed while moving the start into the past" has no test that fails if its handling is removed.

## Gates per PR

1. `pnpm ci:check` green locally and `pnpm check:tenancy`.
2. Playwright spec under `e2e/specs/`, mutation-proven (PR body shows it red against one deliberate break). Local E2E only under `flock /tmp/crestahq-e2e.lock` and never while a CI E2E job runs.
3. New collection/field with rules or index impact → `firestore.rules` / `firestore.indexes.json` in the PR; deploy is manual, a **union of every open branch's rules**, then once more from `main` after the last merge. Indexes too.
4. Blind `/review`; `review-team` for 500+ lines; one reviewer hunts unreachable paths. Fix rounds are their own review target.
5. Merge via REST when CI is green and review is APPROVED; update Status here and add an evidence screenshot.

## Decision summary (grilled 2026-09-13 from the repo and GHL side by side; Hein's overrides welcome)

**Verdict:** Proceed with constraints.

**Design concept:** a booking page *is* a GHL calendar. SP3 gives it a type, a richer rule set and external busy time — and routes every slot decision through one resolver so a rule added once applies to the public page, booking, rescheduling, voice and Google alike.

**Rulings (defaulted — each is the one to overturn if wrong):**
1. **No renames.** Booking pages stay `bookingPages`, events stay `events`, stored statuses stay (`scheduled`, `completed`…); GHL's words are UI labels. Every new field is optional with a legacy default, so old docs behave exactly as today.
2. **Hostless pages keep "everything blocks".** Only typed pages with hosts get per-host busy. A hostless page cannot use Google busy (there is no one to read) — the editor says so.
3. **Class seats = one event per attendee.** Each attendee keeps their own confirmation, reminders, reschedule link and status; seat count is derived by counting same-page events at the slot start.
4. **Collective events carry `hostUids[]`** and block every listed host; `assignedToUid` is the first host so every existing owner-based view keeps working.
5. **Rescheduled is a marker, not a status** (`rescheduledAt`, `rescheduleCount`), because the event doc is moved in place and GHL has no such status.
6. **Google connection is per member** (GHL's model, and round robin needs each host's busy), stored like the GBP token: an Admin-SDK-only doc under `subAccounts/{id}/private/`. The GBP connection is untouched; the shared `/api/google/callback` routes by a signed `purpose` in `state`.
7. **Primary calendar only** for both linked and conflict calendars — picking other calendars needs the `calendarlist` scope, which the goal did not ask for.
8. **Google failure fails open with a visible warning.** If Google is unreachable or the token is revoked, slots are computed without that host's Google busy and the connection card shows the failure. The alternative (no slots at all) takes the business offline because of a Google outage. *Overturn if* double-booking is worse than downtime for these businesses.
9. **Deleting the event in Google does not cancel the booking.** Busy is read live, so a moved/deleted Google event changes availability; LeadStack stays the record for the appointment itself.

**Proven assumptions (checked at `cb1323b`):**
- Team mode, per-host hours, host selection, min notice, max per day, visible days, multi-range hours, reminders, payment holds and reschedule/cancel tokens all exist and are reused, not rebuilt.
- Reminder scheduling already goes through QStash with per-event dedup ids and a live-event re-check at fire time (`lifecycle.ts:222`, `/api/events/reminder/step`).
- `/embed/*` already sends `frame-ancestors *` for the web-chat widget, so a booking embed under `/embed/` needs no new header rule.
- The Google OAuth client exists (Testing, two test users) with a single deployment-wide callback; adding a scope is a console change plus a second consent per member, not a new client.

**Highest-risk unknown:** (a)'s extraction. Five callers compute availability with slightly different busy loading (the book route uses a transaction, reschedule excludes its own event, voice ignores min notice at confirm time). Mitigation: the resolver takes those differences as explicit options; every existing availability/book/reschedule/voice test must pass unchanged; one reviewer compares each old caller's inputs with its resolver call.

**Other risks:**
- Google consent for `calendar.events` in Testing mode shows the "unverified app" screen; fine for test users, blocks everyone else until verification (not submitted — out of scope by instruction).
- Live Google proof needs a member to grant consent on #1000; that is Hein's account and is asked for, not assumed.
- R2 sends a real reminder email; it goes to an address Hein controls, on #1000 only.

**Explicitly not building:** calendar groups, list filters on the calendars page, Outlook, calendar picker (non-primary calendars), recurring meetings, Rentals, "Invalid" status, minute/day granularity for min notice, Google-side cancellation, video-conference auto-creation, appointment smart lists, "Date added" filter, round-robin "contact routing preference".

**Rollback:** every PR is additive. Reverting (a) leaves `calendarType`/`services`/`hostUids` fields that old code ignores (a class page would fall back to one booking per slot). Reverting (d) leaves token docs nothing reads and Google events nothing updates — disconnect members first.
