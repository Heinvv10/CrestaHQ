# Upstream port plan — LeadStack 1.0.42 → 1.0.54

This is the locked scope for porting upstream `leadstack-agency` 1.0.42 (18d51837) → 1.0.54 (bceae0fc) into CrestaHQ (origin/main). Every unit is a hand port against our files; never `git merge upstream`.

- Owner ruling (Hein, 2026-10-29): **port all features**, and adapt each one where our fork differs.
- Coder rules: `reference_upstream_port_coder_rules.md`. They are binding, as are the conventions of the previous plan (`UPSTREAM_PORT_PLAN.md`).
- Line references point at upstream bceae0fc (the mirror at `/home/hein/Workspace/Leadstack`) or at our tree, as marked.

## Goal: bring every real 1.0.54 feature into CrestaHQ, running on our Paystack, SMTP, Google Calendar and pipeline rails, without regressing what we built after 1.0.42.

### Problems that would bite a verbatim port

1. **Upstream's agent booking engine is weaker than ours.**
   - Upstream `agent-booking-service.ts` computes availability inline with `computeAvailability`/`computeUnionAvailability` (`:186-201`, `:624-664`). Upstream `lib/booking/availability.ts` has no day caps, no availability rules and no calendar types: there are 0 matches for `dayCap|availabilityRules|calendarType|collective|round_robin|service`.
   - Ours goes through `resolvePageAvailability` + `assignBookingHosts` (`voice-booking-service.ts:118-126, 272-291`). They carry collective and round-robin hosts, service pages, availability rules (`availability-rules.test.ts`), day caps (`lib/booking/day-cap.ts`) and long events.
   - Upstream's `getAgentBookingContext` (`:118-134`) also drops our service-page refusal (ours `:95-97`, tested in `voice-booking-service.test.ts:61`).
   - Verbatim result: a collective booking gets only one host, and service pages are booked at the wrong length.
2. **Upstream imports modules we don't have, and lifecycle signatures differ.**
   - Missing modules: `@/lib/booking/external-busy` (`agent-booking-service.ts:16`, `booking-changes-service.ts:14`). Ours is `lib/google-calendar/busy.ts` (`loadGoogleBusyForPage`/`loadGoogleBusyForEvent`).
   - Different Google push API: upstream calls `pushBookingToGoogle({…options})` from lifecycle (`:749-759`), plus `moveGoogleBookingCopy`/`deleteGoogleBookingCopy` (`booking-changes-service.ts:18-21`). Ours is `lib/google-calendar/push.ts` with `pushBookingToGoogle(eventId)` / `pushBookingToGoogleAfterResponse(eventId)`. It already covers reschedule and cancel (`call-sites.test.ts:59-83, 130-137`).
   - Lifecycle helpers: upstream calls `recordBookingActivity` without `subAccountId`, and `fireBookingTrigger({agencyId, subAccountId, contactId})` (`:723-735`). Ours passes `id`, `subAccountId` and `bookingPageSlug` (`voice-booking-service.ts:346-365`).
3. **Upstream drops behaviour we added, and breaks our guards.**
   - Upstream loses our `event_confirmed` trigger (ours `:367-376`).
   - It loses collective `hostUids`, which is written to the event and notifies every host (ours `:323, 392-433`).
   - Upstream `:503` is a bare `void emitContactCreatedById(...)`, and our after-response guard test rejects a bare `void promise`.
   - Upstream `:524-525` has an empty catch, which breaks our zero-tolerance rule.
4. **Our Vapi LLM route has features upstream lacks**, each with its own test:
   - the mystery-shop prompt (`route.ts:246-253`; upstream's route has no `mysteryShop`), `route.mystery-shop.test.ts`;
   - model fallback, `route.model-fallback.test.ts`;
   - first-name-only caller context, plus refusing an outbound `contactId` that belongs to another sub-account, `route.contact-context.test.ts`;
   - `callId` passthrough, `route.call-id.test.ts`.

   Apply A's hunks to our route; never copy upstream's.
5. **Calendar import touches 30 event readers.**
   - Upstream added `isImportedEvent` skips in 12 files. We have `collection("events")` reads in 30 non-test files. They include `google-calendar/push.ts` (3 reads), `booking/hosts.ts`, `resolve-availability.ts`, `events/reminder/step`, `calendar.ics`, `v1/events` and `event-status-service`.
   - What a missed skip does:
     - In push.ts, an imported event gets pushed back into Google (a duplicate or a loop).
     - In hosts.ts, it skews round-robin load.
     - In the reminder step or the ICS feed, it emails a host's private event or leaks it.
   - Scope: upstream `lib/google/calendar.ts:39-40` requests `calendar.freebusy`. Our consent screen is fixed to `calendar.events` (`google-calendar/scopes.ts:7-8`). Import must stay inside that scope; `events.list` is covered by it.
6. **The events rules don't protect imported events yet.**
   - Upstream protects them with `source=="google"`, `createdByUid==auth.uid`, and `googleCalendarOwnerUid`/`googleCalendarEventId` locks (upstream rules `:948-977`).
   - Ours locks `source` and `googleEventIds` on create and update (`firestore.rules:1412, 1425-1426`). But a member can still update other fields of an existing `source=="google"` doc, and can delete it when `googleEventIds` is empty (`:1430-1434`).
   - Hand-merge only the refusal: no client update or delete when `resource.data.source == "google"`.
   - Never copy upstream's rules. They lack our `hostUids`, `assignedToUid`, `icsSequence` and `paidFromTokenHash` locks.
7. **The watchdog changes gate upstream.**
   - Upstream's sweeps require `agentsEnabledByAgency` (`agents-watchdog-service.ts:426, 750`). Ours require `labsEnabledByAgency` + `aiSuiteEnabledByAgency` (ours `:312-313`).
   - Verbatim result: every running watchdog stops, because the new field is undefined, which reads as off.
   - Upstream also imports `pipelines-service` and `pipelines/resolve` (`:8-9`), which we never ported. Ours are `lib/pipelines/server.ts` (`readPipelines`/`loadPipeline`) and `stages.ts` (`dealPipelineId`).
   - Stale deals call the AI (`:850`), so they spend AI credits.
8. **A new `send_ai_sms` node would check the wrong opt-out.**
   - `engine.ts:200-203` (`channelOptedOut`) returns `whatsappOptedOut` for every node type that isn't `send_email` or `send_sms`. `sendSkips` (`:207-210`) feeds the prospecting approach guard (`:2074-2085`).
   - Added verbatim, `send_ai_sms` would skip on a WhatsApp opt-out and ignore an SMS STOP.
   - It is also not in `AT_MOST_ONCE_NODES` (`:1877-1882`), so a QStash retry could text the person twice.
   - It must send through `sendSmsForSubAccount` with `origin:"automated"` so that quiet hours hold it (`twilio.ts:273-292`).
9. **Products and usage billing are Stripe-only upstream.**
   - The buy session uses `getSubAccountStripe`. `createUsageCharge` throws without `STRIPE_SECRET_KEY` (upstream `billing-service.ts:1273-1278`).
   - Our Client Billing is provider-agnostic: `getBillingProvider()` (`lib/billing/provider.ts:246-257`), and both providers implement `createOneTimeCheckout`.
   - Our sub-account money rail is Paystack:
     - `paymentAttempts/{reference}` is written before Paystack is called (`payment-links-service.ts:192-263`, `types/payment-attempts.ts:5-19`);
     - the per-sub-account webhook verifies and reconciles payments (`webhooks/paystack/sa/[subAccountId]/route.ts:76-125`).
   - Only invoices choose between rails today (`invoice-pay-rail.ts:88-145`, order PayPal → Stripe → Paystack).
   - Our existing `/co/[sa]/[slug]` checkout session is Stripe-only as well (`api/co/[subAccountId]/[slug]/session/route.ts:181`).
10. **The static `/co/[sa]/buy` route shadows a checkout page slugged `buy`.** Next resolves a static segment before `[slug]`, and our slug check (`lib/checkout/sanitize.ts:226`) has no reserved list.
11. **Email stats are Resend-only, and they hang off the route we skipped.**
    - `handleResendDeliveryEvent` (`lib/comms/email-events.ts:77`) is called only from upstream `webhooks/resend/inbound/route.ts`, which is SKIP since 1.0.40. Its lookup is `emailEvents/{resendMessageId}` (`:84`).
    - We send through per-sub-account SMTP (`resend.ts:36-48`). Plain SMTP gives no delivery events (`docs/programme/w4-email-tracking.md:90-92`).
    - W4 PR2 already specified our own signed click redirect and open pixel, both off by default.
12. **Slack posts use plain `fetch`** (upstream `lib/slack/client.ts:26`), which follows redirects. The `hooks.slack.com` regex (`slack-service.ts:99`) checks only the first hop. Coder rule: outbound fetch goes through `publicFetch`.
13. **Logo serving needs a new public path.**
    - Upstream's `/api/brand/logo/[scope]/[id]` is unauthenticated (upstream route `:12-41`) and reads `agencies/{id}/brandAssets/logo` or `subAccounts/{id}/private/brandLogo` (`logo-server.ts:21-25`).
    - Our middleware `PUBLIC_PATHS` has no `/api/brand`.
    - An uploaded logo URL must still pass our branding route's server-side URL validation.
14. **Instrumentation moved upstream.** Upstream moved `instrumentation.ts` into `src/`. Ours sits at the repo root and runs in prod (`register()` ran 2026-10-28). Never add `src/instrumentation.ts`.
15. **QStash schedule budget.**
    - We use 7 of 10 slots (`register-schedules.ts`, cap note at `:38`), and the account is now pay-as-you-go.
    - Upstream adds a monthly usage-close and calendar-import sweeps.
    - Fan these out from the existing ticks (`daily-housekeeping`, the 15-minute `email-sync`) instead of adding schedules.
16. **Comment-only noise is not ported.**
    - 917 of 1,165 modified code files (79%, survey) carry only comment or whitespace changes from upstream's comment-rewrite pass. Porting them would churn ~900 files and conflict with every lane.
    - Before touching a file, the coder runs:

      ```
      git diff -w 18d51837 bceae0fc -- <f> | grep -E '^[+-][^+-]' | grep -vE '^[+-]\s*(//|\*|/\*|\*/)'
      ```

      Empty output means the file is comment-only, so leave it.

---

### Inventory

**PORT / ADAPT — the unit sections below give the detail**

| Unit | What | Class |
|---|---|---|
| S1 | Small fixes: relative form redirects; reserve checkout slug `buy` | ADAPT |
| X0 | New agency gates: `agentsEnabledByAgency`, `sellOnlineEnabledByAgency`, `aiOutboundSmsEnabledByAgency` | PORT |
| C0 | `isImportedEvent` skip across all 30 event readers (no-op until C1) | ADAPT |
| B1–B3 | Attendee cancel/reschedule service, location types + Google Meet, booking SMS confirmation and reminders | ADAPT |
| A1–A6 | AI live booking on voice, web chat (typed and spoken), SMS, WhatsApp and Messenger | ADAPT (engine stays ours) |
| C1–C2 | Google Calendar import, rebuilt on `lib/google-calendar/*` | ADAPT |
| D1 | Stale-deals monitor + AI Agents → Monitors page | ADAPT |
| E1 | Slack notifications | ADAPT |
| F1–F6 | Products: sell online, buy links, orders, entitlements, images, feed | ADAPT (Paystack + Stripe) |
| G1–G3 | Usage rebilling: charges, close, overdue banner, agency invoices | ADAPT (provider-agnostic) |
| H1–H2 | Quote e-signature + signed copy | PORT + rules merge |
| I1–I3 | Email campaign stats: own pixel and click (SMTP and Resend) + Resend events webhook | ADAPT |
| J1 | AI outbound SMS workflow step | ADAPT |
| K1 | Logo upload | PORT |
| T1–T4 | Assistant tools: booking, Slack, stale deals, usage | ADAPT (into split capability files) |

**HAVE — already built (do not port)**

| Upstream change | Our evidence |
|---|---|
| SMS quiet-hours retry (`business-hours.ts` retry) | `lib/comms/quiet-hours.ts`, `quiet-hours-hold.ts`, `quiet-hours-release.ts` + seam tests; `sendSmsForSubAccount` holds automated sends (`twilio.ts:292`) |
| `staleAlertedAt` rule lock | `deals` client writes already fully closed (`firestore.rules:1109`) |
| `create_booking_page` + `booking-pages-service.ts` | `capabilities/booking-pages.ts:84`, `lib/server/booking-page-write.ts` |
| ICS attachment helper (`ics-attachment.ts` 47) | We already attach ICS: `book/route.ts:768-786`, `bookings-service.ts:294-325`, `reschedule.ts:242-291`, plus `nextIcsSequence` (`ics.ts:51`). Adopt `icsDomain()` in B1 only to remove our three copies of the app-host code |
| Invite token, `x-user-*` stripping | `middleware.ts:424-445` |
| Usage tools `sub_account_usage`, `set_usage_limits` | `capability-names.test.ts:48-49` (T4 extends them) |
| Watchdog tools | `capabilities/watchdog.ts:39,70` |
| Instrumentation | Root `instrumentation.ts` (problem 14) |
| Upstream pipelines libs | `lib/pipelines/*` (D1 rewires onto it) |

**SKIP — upstream's own sales or distribution machinery, stubs, hygiene**

| Upstream files | Reason |
|---|---|
| `components/agency/buyer-avatar-*` | Upstream's buyer CRM |
| `app/switch/*`, `app/flatpack/*`, `lib/landing/flatpack-stats.ts` | Upstream marketing pages |
| `lib/cloud-instance/heartbeat.ts`, `lib/gitpage/heartbeat.ts` changes, `admin/instances` (now 404), `components/affiliate/instances-table.tsx`, `lib/affiliate/instances-data.ts`, `types/instances.ts` | Upstream's hosted-fleet telemetry |
| `lib/stripe/fulfil-founders.ts`, affiliate buy-link components | Upstream's sales funnel |
| Terms and privacy template rewrites | Ours diverged; product copy is Hein's call |
| Deleting `public/setup.html` | We still serve it |
| `CLAUDE.md`, `.claude/skills/setup/*` | Ours diverged; buyer-onboarding skill (deferred in 1.0.40 too) |
| Moving `instrumentation.ts` into `src/` | Problem 14 |
| `VERSION` bump | Previous ports left VERSION alone |
| **All comment-only diffs (~917 files)** | **NOT ported** (problem 16) |

---

### Conventions for every unit

1. Read `git diff 18d51837 bceae0fc -- <file>` for the real hunks, then apply them to our version. Never copy upstream's `firestore.rules`, `capabilities.ts`, pipelines libs or `lib/google/calendar.ts`.
2. Email goes through `emailIsConfigured(sub)` and `sendEmail({subAccount, meter})`. The suppression list applies automatically.
3. SMS goes through `sendSmsForSubAccount({origin})`, consent through `smsSendBlock`, and the shared sender through `agencyAllowsSharedSms` (`lib/agency/policy.ts`). WhatsApp goes through `send-dispatch.ts`, never Twilio directly.
4. Every new route needs:
   - an entry in `scripts/agent-coverage.json` (a tool or a written exclusion; `FROZEN` may not grow);
   - `isDocId` on every path id;
   - a middleware public-path entry only if it is public.
5. Every new collection or doc goes in `docs/architecture/firestore-collections.md`. Every new env var goes in `docs/environment.md` + `env-schema.mjs`.
6. Each feature PR updates its own `knowledge-base.ts` card and `docs/features/<x>.md`.
7. A unit that cannot be live-walked merges DARK: gate default off, and its doc says "NOT runtime-verified" with the reason.
8. Every rules or index change ships with `firebase deploy --only firestore:rules,firestore:indexes` from main after merge. Check open PRs first.

---

### Per-unit sections

Each unit lists its scope, the files, the adaptation, the gate, any rules or index change, how it is verified, and its merge class. Upstream sizes are additions from the survey.

**S1 — Small fixes (~120 lines)**
- **Scope.**
  - Upstream's form redirect now accepts relative paths. Ours (`lib/forms/redirect-url.ts:9-17`) accepts only absolute http(s). Accept `/path`, and refuse `//…`, `/\…` and control characters.
  - Reserve the checkout slug `buy` in `checkoutSlugError` (problem 10).
- **Verify.**
  - Unit tests for `//evil.com`, `/\evil.com`, `javascript:` and `/thanks`; mutation-check the `//` guard.
  - Before merge, count prod `checkoutPages` with slug `buy` (expect 0).
- **Merge.** HEIN-GATED (public form page).

**X0 — Gates PR (~250 lines)**
- **Gates**, wired per `feature-gates.md` (schema → both creation defaults → PATCH branch → runtime 403 → manage-dialog checkbox → `FEATURE_GATES` entry), plus `GATE_FIELDS` in `lib/audit/record.ts` and a row in the gates doc:

  | Gate | Default | Notes |
  |---|---|---|
  | `agentsEnabledByAgency` | `false` | Stale-deals monitor (D1). Spends AI credits. `assistantMayEnable: false` |
  | `sellOnlineEnabledByAgency` | `false` | F. Moves money: NOT in `PLAN_GATE_KEYS`, like `paymentsEnabledByAgency`. `assistantMayEnable: false` |
  | `aiOutboundSmsEnabledByAgency` | `false` | J. NOT in `PLAN_GATE_KEYS`. `assistantMayEnable: false`. The PATCH branch refuses enable (409) unless the J1 readiness check passes; the readiness function itself lands in J1, and until then the branch refuses outright |

- **Verify.**
  - Defaults are written at both creation sites.
  - The PATCH applies only the fields sent.
  - `GATE_FIELDS` makes tsc fail until all three are listed.
  - `set_feature_gate` refuses to enable any of them.
- **Note.** The manage dialog has a known stale-gates bug (a second Save reverts the first). Verify one gate at a time, in Firestore.
- **Merge.** LEVEL-3 (greenfield fields, default off, test-verified). Previous precedent: G in 1.0.40.

**C0 — Imported-event sweep (~350 lines, 30 files)**
- **Scope.** Add `isImportedEvent(e)` (`source === "google"`) to `types/events.ts`. Skip imported events in every reader where an imported event must not count:
  - availability and busy (`resolve-availability.ts`, `google-calendar/busy.ts`);
  - push (`push.ts`: never push an imported event);
  - host load (`hosts.ts`);
  - reminders, ICS feed and token routes;
  - `v1/events` (exclude, or label `source`);
  - AI context;
  - the AI Suite `events` and `booking-payments` tools;
  - the GHL import bulk write.
- **Verify.** One seam test per reader class that seeds an imported event and asserts it is ignored. Mutate the predicate and the tests must go red.
- **Merge.** HEIN-GATED (touches 30 live paths). It lands before B1, so the booking lane rebases once.

**B1 — Attendee cancel and reschedule service (~900 lines)**
- **Upstream.** `lib/server/booking-changes-service.ts` (519): `cancelBooking` and `rescheduleBooking`, with a guard that runs inside the transaction. Callers are the `/e/[token]` routes and the AI agent.
- **Ours touched.** `lib/booking/reschedule.ts`, `api/events/[token]/{cancel,reschedule}/route.ts`, `server/event-cancel-notice.ts`, `api/events/by-id/[id]/reschedule`.
- **Design merge.** Create a `booking-changes-service.ts` that wraps OUR pieces:

  | Side | What it has that the other lacks |
  |---|---|
  | Upstream | A guard callback that runs inside the transaction, so the AI agent can act as the contact; one cancel/reschedule service shared by every caller; SMS reminders re-scheduled on reschedule |
  | Ours | Operator override (`rescheduleWithoutAvailabilityCheck`); `rescheduleCount` and `isLong` stamps; `nextIcsSequence`; `EventNotifySkipReason`, so the operator learns when the visitor wasn't emailed (the rotated token makes this load-bearing, `reschedule.ts:140-143`); Google push by event id; booking-page existence check; suppression-aware sends; `departedHost` handling |

  Keep our `runRescheduleSideEffects` as the single side-effect path. The token routes keep their HTTP contract.
- **Verify.**
  - Existing `reschedule.test.ts`, `ics-sequence.test.ts` and `call-sites.test.ts` stay green unchanged.
  - New: a guard refusal returns `invalid`, with no write and no token rotation.
  - A double cancel is idempotent.
  - Mutate the in-transaction state check and the tests must go red.
  - Playwright: book → reschedule via `/e` → cancel on the fixture tenant.
- **Live walk.** #1000 booking page: book, reschedule, cancel.
- **Merge.** HEIN-GATED (public token routes). Breaker review.

**B2 — Location types + Google Meet (~900 lines)**
- **Upstream.**
  - `lib/booking/location.ts` (99): `effectiveBookingLocation`, `eventLocationText`.
  - `types/booking`, `validation`, `defaults`, `duplicate` route, `booking-page-editor` (256), `public-booking-view`, `book` route.
- **Adapt.**
  - Meet goes into OUR `google-calendar/push.ts`: `conferenceData.createRequest` with `conferenceDataVersion=1`, which works under the `calendar.events` scope. No new scope.
  - When `googleMeet` is on, the push must finish BEFORE the confirmation email (it carries the link), so for those pages the book route awaits the push instead of running it after the response.
  - Meet needs `googleCalendarEnabledByAgency` and a connected host. Otherwise the editor disables the option and validation refuses it.
- **Verify.**
  - Validation refuses unknown location types and Meet without the gate.
  - The confirmation email carries the Meet link from the push result.
  - "We call you" uses the booker's phone.
  - Mutate the gate check and the tests must go red.
  - Playwright on `/b` with an address-type page.
- **Live walk.** #1000 with a connected member (calendar sync is live).
- **Merge.** HEIN-GATED (public booking pages, customer email).

**B3 — Booking SMS confirmation and reminders (~450 lines)**
- **Upstream.**
  - `lib/booking/sms.ts` (167).
  - `smsRemindersEnabled` on the page, used in the reminder step, `lifecycle.ts` scheduling and the editor toggle.
- **Adapt.**
  - Send through `sendSmsForSubAccount` with `origin:"automated"`.
  - The confirmation passes `selfTriggeredBookingAt`, so a self-booked confirmation is exempt from quiet hours (`quiet-hours.ts:27-42`).
  - A reminder held by quiet hours past the appointment start is dropped, not sent late.
  - Use `smsSendBlock` and `agencyAllowsSharedSms`. Thread rows are written only in dedicated mode (as upstream does).
  - No WhatsApp variant in this unit.
- **Verify.**
  - Opted-out contact → not sent.
  - Quiet-hours hold → deferred.
  - Reminder held past start → skipped.
  - Mutate `origin` and the tests must go red.
- **Live walk.** Only if #1000 has an SMS sender. Otherwise merge DARK: the per-page toggle defaults off, and the doc is marked NOT runtime-verified.
- **Merge.** HEIN-GATED (outbound customer SMS).

**A — AI live booking (the engine decision first)**

**Recommendation: keep OUR engine, adopt upstream's API.** Create `lib/server/agent-booking-service.ts` with upstream's exported surface:
- `AgentBookingChannel`, `getAgentBookingContext`, `listAgentSlots`, `listRescheduleSlots`, `loadChangeableBookings`, `findRecentAgentBooking`, `bookAgentSlot`, `formatSlotForSpeech`, `formatSlotForChip`;
- the per-channel copy (`CHANNEL_COPY`), email/phone/intake/address/`locationPhone` inputs, and the website confirmation path.

Its internals are our `voice-booking-service.ts` core. Then delete `voice-booking-service.ts` and move its call sites and tests: `call-sites.test.ts:119-128`, `external-busy.test.ts:58-64`, `voice-booking-service.test.ts`.

**Why ours wins** (problems 1–3): every behaviour we added has a test. Upstream's engine has none of the calendar-type, rule or day-cap logic. Rebuilding ours inside upstream's file would mean re-deriving 6 test suites' worth of behaviour.

**What must survive from ours.** Each item needs a test in A1:
1. Service pages are refused.
2. Collective: slots only where every host is free; every host booked; `hostUids` written.
3. Round-robin least-loaded only on `round_robin` pages (`:244-252`).
4. Named host via `selectableHostUid`; never silently reassigned.
5. `ignoreMinNotice` on the re-verify.
6. Google busy via `loadGoogleBusyForPage`, failing open.
7. `pushBookingToGoogleAfterResponse` on every booking.
8. `event_booked` and `event_confirmed`.
9. Every host gets the notification email.
10. `voiceCalls/{callId}.voiceBooking.booked` stamp and the `attemptedAt` stamp (feeds the follow-up task in `end-of-call.ts:117-205`).
11. `runAfterResponse` for `contact.created`.
12. Availability rules and day caps through `resolvePageAvailability`.

**Upstream behaviour added on top:**
- per-channel `createdByUid` and notes;
- website bookings require a reconciled contact;
- fill blank email/phone with `normalizePhoneLenient`;
- intake answers and location text in the notes;
- a confirmation email + SMS + reminders for website bookings (via B3);
- a replay finder so a provider retry doesn't double-book;
- reschedule slots for the assigned host only.

**A1 — Engine (~1,300 lines)**
- **Files.** `agent-booking-service.ts` as above, using `booking-changes-service` from B1, location helpers from B2 and booking SMS from B3.
- **Verify.** The 12 items above, plus `findRecentAgentBooking` replay. Mutate `ignoreMinNotice` and the collective check, and the tests must go red.
- **Merge.** HEIN-GATED (creates real bookings, emails customers).

**A2 — Booking tools / turn / caps libraries (~1,400 lines)**
- **Files.** `comms/ai/booking-tools.ts` (836), `booking-turn.ts` (336), `booking-caps.ts` (81, verbatim). Pure marker parsing, prompt blocks and offer state; nothing is wired.
- **Adapt.** Fold in our voice-route helpers (`resolveRequestedHost`, `ANY_HOST_PHRASES`, the copy-the-start-value rules at `route.ts:442-479`) so voice keeps its hardening.
- **Verify.** Parser tests for malformed and forged markers. Caps per IP, conversation and workspace (mutation on each limit).
- **Merge.** LEVEL-3 (greenfield pure modules, no caller until A3–A5, test-verified).

**A3 — Voice rewire (~600 lines)**
- **Files.** Our Vapi LLM route uses A2's tools block and A1's engine, keeping problem 4's features intact. Caller cancel and reschedule only when `voice.allowCallerChanges === true` (upstream `route.ts:323`, default false). Intake only when `bookingAskIntake`.
- **Verify.** All four existing route test files stay green; new tests for cancel/reschedule refused without `allowCallerChanges`.
- **Before merge.** Count prod sub-accounts with `voice.bookingPageSlug` set; their behaviour must be unchanged.
- **Live walk.** One test call on #1000's AI line (spends Vapi minutes; Hein places the call).
- **Merge.** HEIN-GATED (live voice path). Breaker review.

**A4 — Web chat booking (~1,400 lines)**
- **Files.** `comms/web-chat/booking.ts` (355); our `web-chat/{respond,session}.ts`; `api/web-chat/{poll,message}` routes; `chat-window.tsx` slot chips (279); speech filler streaming in our `lib/web-voice/speech.ts` and the elevenlabs webhook (WV-2 path, which stays behind `webVoiceEnabledByAgency`).
- **Adapt.**
  - Session `bookings`/`bookingOffer` are server-written.
  - Changes are limited to bookings made in this session (upstream `:101-109`).
  - Caps use the IP from our `checkout/client-ip`.
- **Verify.**
  - The origin check is still enforced.
  - A third booking in one session → caps refuse.
  - Cancel of a non-session event → refused.
  - Mutate the session-scoping and the tests must go red.
  - Playwright: widget book on the fixture tenant.
- **Live walk.** #1000 widget on crestahq.com: book, move, cancel; then delete the event.
- **Merge.** HEIN-GATED (public anonymous route). Breaker review.

**A5 — Messaging booking (~600 lines)**
- **Files.** `comms/ai/messaging-booking.ts` (247); hunks onto our `comms/ai/respond.ts` (which keeps quiet hours, loop guard, mystery shop and email drafts).
- **Adapt.**
  - Booking tools are **never on the `email` channel**: it is draft-only, and a booking is an executed write.
  - WhatsApp replies go through `send-dispatch.ts`, so Cloud's 24-hour window and the bridge both apply.
  - `conversations/{contactId}.bookingOffer` is server-only.
- **Verify.** The email channel gets no tools. A provider retry finds the earlier booking via the replay finder, with no second event. Quiet hours still hold the reply.
- **Live walk.** #1000 WhatsApp Cloud (a text from Hein's phone).
- **Merge.** HEIN-GATED (customer-facing AI).

**A6 — Setup service + settings (~650 lines)**
- **Files.** `ai-booking-setup-service.ts` (273), `agent-booking-section.tsx` (223); AI-agents channel and profile routes get the `bookingPageSlug`, `allowCallerChanges` and `bookingAskIntake` fields.
- **Gate.** None new: the per-channel booking page (default unset) is the opt-in (Decision 6).
- **Verify.** Unit tests on the PATCH validation (slug must be a published, bookable page in this sub-account; `isDocId`). Playwright: settings page loads.
- **Merge.** HEIN-GATED.

**C1 — Calendar import engine (~1,300 lines)**
- **Upstream.** `lib/google/calendar-import.ts` (900), `calendar-sync/import` and `calendar-import/step` routes.
- **Adapt.**
  - Rebuild on `lib/google-calendar/connection.ts` tokens: `events.list` on the primary calendar, sync token.
  - Never call `lib/google/calendar.ts`, never request a new scope.
  - Imported events: `source:"google"`, `createdByUid` = the connected member.
  - Detail level per Decision 4 (`stripImportedDetails`).
  - Workspace allowance (admin) and member opt-in, both under `googleCalendarEnabledByAgency`.
  - Ticks fan out from the 15-minute `email-sync` schedule; no new QStash schedule (problem 15).
  - Disconnect or gate off → `deleteImportedEvents`.
- **Rules.** The events hunk from problem 6.
- **Indexes.** Add only what `git diff 18d51837 bceae0fc -- firestore.indexes.json` shows for events. Run the import queries against the emulator and add only the composites they demand.
- **Verify.**
  - A rules test: a member cannot update or delete a `source=="google"` event; can still edit a manual one.
  - Mutate the rule and the test must go red.
  - Import is idempotent on re-run.
  - An imported event is never pushed (C0 test reused).
  - Gate off → no import, and existing imports removed.
- **Live walk.** #1000 connected member.
- **Merge.** HEIN-GATED (rules, OAuth tokens, private host data). Breaker review.

**C2 — Import UI (~500 lines)**
- **Files.** Calendar-sync section (205), `event-dialog`/`calendar-view` read-only rendering for imported events.
- **Verify.** Playwright on the calendar page, with imported events rendered read-only. **NOT browser-verified** until the walk.
- **Merge.** HEIN-GATED.

**D1 — Stale-deals monitor + Monitors page (~1,300 lines)**
- **Upstream.** Stale-deals half of `agents-watchdog-service.ts` (`:679-1010`), `agents/stale-deals` route (219), `stale-deals-section` (431), `ai-agents/monitors/page.tsx`, `watchdog-section` moved out of `components/labs`.
- **Adapt.**
  - Pipelines through `lib/pipelines/server.ts` + `stages.ts` (problem 7).
  - The query respects our deals `mode` field: live deals only.
  - Gates per Decision 1: stale deals require `agentsEnabledByAgency` + `aiIsConfigured()`; the watchdog keeps labs + aiSuite.
  - Actions stay additive: a task, push, activity and the `staleAlertedAt` stamp (server-only already).
  - The sweep rides the existing hourly `leadstack-agents-watchdog` schedule.
- **Index.** Deals on (`subAccountId`, [`mode`,] `stageChangedAt` ASC), whichever the final query needs. Ours has only DESC variants (`firestore.indexes.json:522-608`).
- **Verify.**
  - One alert per stage visit (a stage change re-arms it).
  - Gate off → skip.
  - A custom-pipeline terminal stage is never flagged.
  - Mutate the re-arm check and the tests must go red.
  - Playwright: Monitors page.
- **Live walk.** #1000 with a test deal and a 1-day threshold.
- **Merge.** HEIN-GATED (modifies the live watchdog service).

**E1 — Slack notifications (~1,200 lines)**
- **Upstream.** `slack-service.ts` (264), `lib/slack/{client,events,format}` (450), `sub-accounts/[id]/slack{,/test}` routes, section (382), hook in `lib/api/webhooks/dispatch.ts:10,58-62`.
- **Adapt.**
  - `postSlackMessage` goes through `publicFetch` (no redirects, `maxBytes` small, one timeout).
  - The URL is checked by the `hooks.slack.com/services/` regex AND `new URL` (https, exact host).
  - The webhook URL is a secret: `subAccounts/{id}/private/slack`, with display metadata only on the sub doc.
  - Never log the raw error.
  - The dispatch hook runs with `runAfterResponse` and is self-guarded, so a Slack failure never affects webhook delivery.
- **Gate.** None (admin-only routes); Decision 7.
- **Verify.**
  - `ssrf-callers.test.ts` gets a Slack case pointing at a loopback server, and a 302-to-loopback case refused.
  - Mutate the host check and the tests must go red.
  - Revoked (404/410) marks the hook revoked.
  - Dispatch still delivers webhooks when Slack throws.
- **Live walk.** Needs a Slack webhook URL from Hein; otherwise inert until a tenant connects. Doc marked NOT runtime-verified.
- **Merge.** HEIN-GATED (live dispatch path; client data to a third party). Breaker review.

**F — Products sell online.** The rail is decided once, in F2: a new `lib/server/product-pay-rail.ts`, `chooseProductPayRail(sub, currency)`.
- Stripe is ready when Payments is on, `stripeConnectionMeta.ready` is true and `stripeCanChargeCurrency(currency)`.
- Paystack is ready when Payments is on, a connection exists and the currency is ZAR.
- The order between them is Decision 2.
- Selling also needs `sellOnlineEnabledByAgency`.
- An order already paid is always fulfilled, whatever the gate state.

**F1 — Sell-online model + editor (~900 lines)**
- **Files.** `lib/products/sell-online.ts`, `products-catalog-service`, `products-sell-online-service`, `product-sell-online-panel`, `types/products` fields, `create-from-product` hunks.
- **Verify.** Validation of price, currency and slug; the gate refuses enabling; a slug collision with a checkout page is refused.
- **Merge.** HEIN-GATED (it enables a money path).

**F2 — Buy pages + sessions + Stripe path (~1,400 lines)**
- **Files.** `/co/[sa]/buy`, `/co/[sa]/buy/[slug]`, the `thanks` pages, `api/co/[sa]/buy{,/[slug]}/session`, `product-buy-service`, `buy-button`/`buy-shell`.
- **Adapt.**
  - `createPendingOrder` (`orders-service.ts:106`) runs before any provider call.
  - The Stripe path ports onto our `stripe/order-reconciler.ts`.
  - The thanks page reads order state, never query params.
  - Our per-IP checkout rate limit applies.
- **Verify.**
  - Gate off → 404/403.
  - Non-ZAR on a Paystack-only tenant → refused.
  - The amount comes from the product doc, never from the body.
  - Mutate the amount source and the tests must go red.
  - Playwright on `/co/[fixture]/buy/<slug>` (render plus a refused session).
- **Merge.** HEIN-GATED. Breaker review.

**F3 — Paystack order path + order confirmation (~800 lines)**
- **Files.** Session → `paymentAttempts/{reference}` with a new `orderId` (mode and `keyFingerprint` as for links), committed before `initializePaystackTransaction`. Extend `reconcilePaystackCharge`: an attempt with an `orderId` verifies amount, currency, domain and key, then calls `markOrderPaid` (already idempotent, `orders-service.ts:195-203`), `emitOrderEvents`, and the order confirmation (195) via `sendEmail`.
- **Verify.**
  - Replay of `charge.success` → one paid order, one email.
  - Amount mismatch → flagged attempt, nothing paid.
  - Stale key → flagged (existing path).
  - Mutate the amount check and the tests must go red.
- **Live walk.** One R10 product buy on #1000's live Paystack key (real money; refund after). Hein approves the spend.
- **Merge.** HEIN-GATED. Breaker review.

**F4 — Entitlements (~700 lines)**
- **Files.** `entitlements-service.ts` (437), `types/entitlements`. Community grant uses our `community-purchase-service`, `member-account`, `member-auth` and `community-classroom-service` (all present). Deterministic id `orderId_productId` stops a double grant. Grant runs after the order is paid, via `runAfterResponse`. Staff "Re-send delivery".
- **Rules.** New `entitlements/{id}`: member read (`canAccessSub`), `write: if false` (upstream `:848-854`).
- **Verify.** Replay → one grant. A banned or deactivated member → `DeliveryError` recorded on the order. Rules test.
- **Merge.** HEIN-GATED (rules; grants access to paid content). Breaker review.

**F5 — Product images (~700 lines)**
- **Files.** `product-images-service`, `product-images-storage`, `images` routes, `product-images-field`.
- **Adapt.** Upload to our Storage bucket under `products/{saId}/{productId}/` works without gitpage. The AI "generate" path needs `GITPAGE_API_KEY`: prod has none, so that path merges DARK (503 with a message). Delete is limited to the product's own prefix and refuses `..` (upstream `:163-164`). Storage access is Admin SDK only, so `storage.rules` is unchanged.
- **Verify.** Path traversal refused; MIME and size caps; generate gives 503 without the key.
- **Merge.** HEIN-GATED. Docs: generate is NOT runtime-verified (no `GITPAGE_API_KEY`).

**F6 — Products feed + sync + website picker (~600 lines)**
- **Files.** Public `api/products-feed/[subAccountId]` (sell-online products only), `products/sync-notify` (QStash-signed), `products-sync-service`, `website-products-picker`.
- **Adapt.** The feed exposes only public fields and 404s while the gate is off. Add a middleware public path.
- **Status.** DARK: prod has no `GITPAGE_API_KEY` and `websiteEnabledByAgency` is off.
- **Verify.** The feed leaks no cost or internal fields; gate off → 404; an unsigned sync-notify → 401.
- **Merge.** HEIN-GATED (public route). Breaker review.

**G — Usage rebilling.** Two flags, both default off, set only through agency-owner routes. The `subAccounts` doc is already server-write-only (`firestore.rules:261`), so no rules change is needed.
- `agencies/{id}.usageRebillingEnabled`
- `subAccounts/{id}.usageRebillingEnabled`

**G1 — Usage meter + agency usage section (~1,300 lines)**
- **Files.** Upstream's `usage-meter.ts` hunks onto ours (`usageMonthKey`, `getEffectiveRates`, `computeOverage` already exist), `sub-account-usage-section` (692) onto our component, `billing/usage*` libs.
- **Adapt.** Fix the known usage-route bug: the currency defaults to `usd`. It must come from the agency's billing currency (ZAR on Paystack).
- **Verify.** Overage maths fixtures; flags off → no charge preview.
- **Merge.** HEIN-GATED.

**G2 — Usage close + charge (~1,000 lines)**
- **Files.** `usage-billing-service` (525), `createUsageCharge`, `freezeMonthForSubAccount`.
- **Adapt.**
  - Replace `billingStripeIsConfigured()` (problem 9) with `getBillingProvider().isConfigured()`.
  - The charge is a `billingCharges` doc (`types/billing.ts:268`) with new optional `kind:"usage"`, `usageMonth`, `lineItems`, `dueAt`, `payUrl`, `remindedAt`, `emailedTo`.
  - Payment goes through the existing `/pay/charge/[token]` → `createChargeCheckoutSession` → `provider.createOneTimeCheckout`. Paystack needs `payerEmail` from `billingRecipient(sub)`.
  - Keep upstream's deterministic id + `create()` ALREADY_EXISTS idempotency (upstream `:1279-1316`).
  - The close runs from `daily-housekeeping` on the 1st (SAST).
  - Verify that our agency Paystack webhook settles a one-time `billingCharges` doc; if it doesn't, add that here.
- **Verify.**
  - The close re-run creates one charge.
  - Both flags required.
  - Paystack without an email → refused loudly.
  - Mutate the idempotency and the tests must go red.
- **Status.** Merge DARK (flags off). NOT runtime-verified: a live walk means charging a real client.
- **Merge.** HEIN-GATED (money). Breaker review.

**G3 — Overdue banner/paywall + agency invoices (~1,400 lines)**
- **Files.** `billing-guard.tsx` hunks, `usageOverdue` on the sub doc, `use-pay-usage-charge`, `agency-invoices-panel` (402), manage-dialog tabs (578; after X0), plan-editor hunks.
- **Adapt.** The paywall per Decision 3.
- **Verify.** Unit tests of the guard state: none, banner, wall.
- **Merge.** HEIN-GATED (can wall a live client workspace).

**H1 — Quote e-signature (~600 lines)**
- **Files.** `quotes/signature.ts` (111), `public-quote-view` (127), our `api/quotes/[token]/respond` route (+92), `requireSignature` on quotes.
- **Rules.** Hand-merge into our quotes block (`firestore.rules:1263-1302`), keeping the `paidVia`/`autoCharge` locks:
  - no client create carrying `signature`;
  - `signature` unchanged on update;
  - a signed quote may change only `["updatedAt","status","paidAt","autoCreateDealOnAccept","dealId","paymentDueDays"]` (upstream `:872-888`).

  First grep every client-SDK quote update and confirm it still passes on a signed quote.
- **Verify.**
  - The fingerprint survives renumbering to an invoice.
  - A signed quote's line items can't be edited (rules test).
  - Mutate `hasOnly` and the test must go red.
  - Playwright on `/q/[token]` sign flow.
- **Live walk.** #1000: a quote to Hein's own address; sign.
- **Merge.** HEIN-GATED (public route + rules). Breaker review.

**H2 — Signed copy (~350 lines)**
- **Files.** `signed-copy.ts` (143), `pdf-document` hunks onto our `lib/quotes/pdf-document.tsx`. Emailed via `sendEmail` to the signer and the business.
- **Verify.** One email per signature (replay-safe); the PDF carries the fingerprint.
- **Merge.** HEIN-GATED (customer email).

**I1 — Our own open pixel + click redirect (~900 lines)**
- **Upstream gap.** Upstream has nothing for SMTP; this unit builds the W4 PR2 spec.
- **Tokens.** HMAC per `tracked-links/token.ts:38-48` over `{broadcastId}.{contactId}[.{linkIdx}]`.
- **Routes.** `/t/o/[token]` returns a 1×1 GIF with `no-store`. `/t/c/[token]` 302s only to a destination stored at send time (`broadcasts/{id}/links/{i}`), never one from the query string, and 404s otherwise (same as `/l/[token]`, `route.ts:7-28`).
- **Where.** Instrumentation happens in the broadcast step (`api/broadcasts/email/step/route.ts`) only when the sub-account's `emailTracking.{opens,clicks}` is on (default off, W4). Never wrap `{{unsubscribeLink}}` (`/u/…`), `mailto:` or `tel:`.
- **Data.** Writes upstream's send-row fields (`openedAt`, `clickedAt`, counts) and the `email.opened`/`email.clicked` contact activities, so I3 is provider-agnostic. Opens are labelled an estimate (Apple Mail Privacy Protection). POPIA note in the settings copy.
- **Verify.**
  - A forged token → 404, no write.
  - The click destination comes from the stored doc, not the query.
  - The unsubscribe link is not rewritten.
  - Tracking off → body byte-identical.
  - Mutate the HMAC compare and the tests must go red.
  - Playwright: the click route redirects; a bad token 404s.
- **Live walk.** #1000 broadcast to Hein's own address.
- **Merge.** HEIN-GATED (public routes; changes outbound email bodies). Breaker review.

**I2 — Resend events webhook, for buyer copies (~450 lines)**
- **Route.** New `/api/webhooks/resend/events`, not the skipped inbound route.
- **Security.**
  - Svix signature over the raw body, size capped first (`readBodyCapped`), timestamp tolerance, constant-time compare.
  - `RESEND_WEBHOOK_SECRET` unset → reject.
- **Data.** The broadcast step writes `emailEvents/{messageId}` only when the send went via Resend. A lookup whose `subAccountId` doesn't match is ignored. `handleResendDeliveryEvent` hunks.
- **Bounces.** A bounce writes our suppression doc (`hard_bounce`, `email-suppression.ts:32`) + `contact.emailBouncedAt`; a complaint writes suppression `complaint`.
- **Cleanup.** `emailEvents` is pruned by `api-cleanup` (as upstream does).
- **Env.** `RESEND_WEBHOOK_SECRET` → `docs/environment.md`, `env-schema.mjs`.
- **Status.** DARK on our prod: no Resend. NOT runtime-verified.
- **Verify.** Unsigned, old-timestamp and oversized requests → 4xx. Mutate the signature check and the tests must go red.
- **Merge.** HEIN-GATED (public webhook). Breaker review.

**I3 — Stats page + triggers + bounce flag (~900 lines)**
- **Files.**
  - Our `broadcasts/[broadcastId]/page.tsx` gets the stats. Delivered and bounced show "Not available for SMTP" (W4), never 0.
  - `broadcast-trigger-filter`.
  - `email.opened`/`email.clicked` workflow triggers (engine trigger matching; after J1).
- **Rules.** The contacts update rule (`firestore.rules:1001-1010`) gains the `emailBouncedAt` hunk: clients may clear it, never set it (upstream `:696-698`).
- **Verify.** The rules test mutated red. A trigger fires once per contact per broadcast.
- **Merge.** HEIN-GATED (rules; open-triggered automations message customers).

**J1 — AI outbound SMS (~800 lines)**
- **Files.**
  - `comms/ai/outbound-sms.ts` (210, readiness);
  - readiness route;
  - the `send_ai_sms` step in our engine;
  - the X0 PATCH branch refusing enable unless readiness passes.
- **Adapt** (problem 8):
  - add `send_ai_sms` to `AT_MOST_ONCE_NODES`;
  - `channelOptedOut`/`sendSkips` treat it as SMS (`smsSendBlock`);
  - the approach guard applies;
  - send via `sendSmsForSubAccount({origin:"automated"})` (quiet hours hold it);
  - readiness requires a dedicated Twilio number (as upstream does) and reads the token through `readSubAccountSecret`;
  - usage meter `smsSegments` + `aiTokens`;
  - the runtime re-checks the gate and readiness on every send.
- **Scope.** SMS only (Decision 5).
- **Verify.**
  - SMS opt-out → skipped; a WhatsApp opt-out alone → still sent.
  - A retry after the claim → no second text.
  - Quiet hours → held.
  - Gate off → skipped.
  - Mutate each of those and the tests must go red.
- **Status.** Merge DARK (gate default off). Live walk only on a tenant with a dedicated Twilio number; otherwise NOT runtime-verified.
- **Merge.** HEIN-GATED (outbound AI messaging).

**K1 — Logo upload (~500 lines)**
- **Files.** `brand/logo-{server,shared}`, `render-logo-client`, `api/{agency,sub-accounts/[id]}/logo`, public `api/brand/logo/[scope]/[id]` (PNG/WebP only; magic-byte check; dimension cap; `nosniff`; immutable cache).
- **Adapt.** Add `/api/brand/logo` to the middleware public paths. Make sure our branding route's `logoUrl` validator accepts our own origin. Docs live under the existing deny-all `private/*` and `agencies` paths, so no rules change.
- **Verify.** SVG and HTML refused; oversize refused; a bad id → 404; the served `Content-Type` comes from the stored mime only.
- **Live walk.** #1000: upload a logo; it appears in a booking confirmation email.
- **Merge.** HEIN-GATED (public route; logo in customer email).

**T1–T4 — Assistant tools (new files under `capabilities/`; never upstream's monolith)**

| PR | Tools | Surfaces / approval | After |
|---|---|---|---|
| T1 (~300) | `ai_booking_readiness` (read: chat + agent), `configure_ai_booking` | Chat may only switch booking off (`chatRefusal` on enable); the agent path is a proposal approval class | A6 |
| T2 (~250) | `slack_status` (read: chat + agent), `configure_slack_events` (chat, admin, confirm-gated), `connect_slack` | `connect_slack` is UI-only: `chatRefusal`, because it stores a secret and posts | E1 |
| T3 (~200) | `stale_deals_status` (read), `configure_stale_deals_monitor` (chat, admin, confirm-gated) | | D1 |
| T4 (~250) | Upstream changes to `sub_account_usage` / `set_usage_limits` (rebilling fields) | Surfaces as today | G2 |

- **Each T PR adds:** a `FIXTURE_ARGS` row in `src/test/outbound-fixtures.ts` per agent-surfaced tool, a `capability-names.test.ts` row (surface + approval class), and must pass `pnpm check:tenancy`.
- `create_booking_page` stays agent-only (Decision 8).
- **Merge.** All HEIN-GATED (they change what the assistant may do).

---

### Task DAG and PR boundaries

```
S1 ─┐                       (parallel, first)
X0 ─┤──► D1 ──► T3
    │──► F1 ──► F2 ──► F3 ──► F4          F1 ──► F5 (dark gen)   F1 ──► F6 (dark)
    │──► J1 ──► I3
    └──► G1 ──► G2 ──► G3 (manage dialog after X0) ──► T4
C0 ──► B1 ──► B2 ──► B3 ──► A1 ──┬──► A3 (voice)
                    A2 (any time)┤──► A4 (web chat) ──► A5 (messaging) ──► A6 ──► T1
C0 ──► C1 ──► C2      (C1 rules hunk sequenced after H1, see below)
E1 ──► T2             H1 ──► H2           I1 ──► I2 ──► I3            K1
T lane is serial: T3 → T2 → T1 → T4 in merge order of their parents.
```

- **Parallel lanes once S1, X0 and C0 merge.** Booking (B→A), Calendar (C1/C2), Products (F), Usage (G), Email stats (I), and independents E1, H1/H2, K1, D1, J1.
- **Size.** Every PR is ≤ ~1,400 changed lines, tests excluded. Use `review-team` for any PR over 500 lines.

**Shared-file conflicts (sequence these, don't run in parallel)**

| File | PRs, in this order |
|---|---|
| `firestore.rules` | H1 → C1 → F4 → I3 (each its own hunk; deploy after each merge) |
| `firestore.indexes.json` | D1 → C1 |
| `middleware.ts` | K1 → I1 → F2 → F6 |
| `types/tenancy.ts` | X0 → G1 → I1 (`emailTracking`) → E1 (slack meta) → C1 (import allowance) |
| Gate wiring (feature-gates route + service, manage dialog, `helpers.ts` `FEATURE_GATES`, `audit/record.ts`, signup, sub-accounts-service) | X0, then G3 |
| `lib/workflows/engine.ts` | J1 → I3 |
| Booking core (`book/route.ts`, `reschedule.ts`, `/e` routes, `types/booking.ts`, `booking-page-editor.tsx`, `lifecycle.ts`) | C0 → B1 → B2 → B3 → A1 |
| `comms/ai/prompt.ts` | A4 → A5 |
| Paystack reconciler + `types/payment-attempts.ts` | F3 only |
| `billing-service.ts`, `types/billing.ts` | G2 → G3 |
| `daily-housekeeping` route / `register-schedules.ts` | G2 → C1 |
| `capability-names.test.ts`, `outbound-fixtures.ts`, capabilities registry | T lane, serial |
| `knowledge-base.ts` | Every feature PR; rebase-only conflicts |
| `env-schema.mjs`, `docs/environment.md` | I2 |

Expect semantic merge breaks (precedent: #184/#186, WS-3). Re-run CI after merging main into a branch, before merge.

**PR table**

| PR | ~Lines | Merge |
|---|---|---|
| S1 | 120 | HEIN |
| X0 | 250 | LEVEL-3 |
| C0 | 350 | HEIN |
| B1 | 900 | HEIN |
| B2 | 900 | HEIN |
| B3 | 450 | HEIN |
| A1 | 1,300 | HEIN |
| A2 | 1,400 | LEVEL-3 |
| A3 | 600 | HEIN |
| A4 | 1,400 | HEIN |
| A5 | 600 | HEIN |
| A6 | 650 | HEIN |
| C1 | 1,300 | HEIN |
| C2 | 500 | HEIN |
| D1 | 1,300 | HEIN |
| E1 | 1,200 | HEIN |
| F1 | 900 | HEIN |
| F2 | 1,400 | HEIN |
| F3 | 800 | HEIN |
| F4 | 700 | HEIN |
| F5 | 700 | HEIN (dark generate) |
| F6 | 600 | HEIN (dark) |
| G1 | 1,300 | HEIN |
| G2 | 1,000 | HEIN (dark) |
| G3 | 1,400 | HEIN |
| H1 | 600 | HEIN |
| H2 | 350 | HEIN |
| I1 | 900 | HEIN |
| I2 | 450 | HEIN (dark) |
| I3 | 900 | HEIN |
| J1 | 800 | HEIN (dark) |
| K1 | 500 | HEIN |
| T1 | 300 | HEIN |
| T2 | 250 | HEIN |
| T3 | 200 | HEIN |
| T4 | 250 | HEIN |

That is ~29,000 lines over 36 PRs. Production deploys stay after hours, each with Hein's explicit go.

---

### Review strategy

- **Every PR.**
  - Blind `/review`: raw diff + CLAUDE.md files only, never the builder's reasoning. Use `review-team` at 500+ lines.
  - Ask reviewers about ABSENCE: a guard missing, a reader not skipped, a test that can't fail.
  - Report findings verbatim and fix them before asking to merge.
  - Fix rounds get their own review.
- **Add a breaker** (adversarial, mutation-driven; time-boxed ~30 min; vitest in the foreground with explicit files + `--testTimeout`) for:
  - B1 (public `/e` token routes);
  - A1/A3/A4/A5 (bookings from anonymous or spoofable callers, Vapi webhook, public web chat);
  - C1 (OAuth tokens, rules);
  - E1 (outbound fetch, SSRF);
  - F2/F3/F4/F6 (public buy routes, money, webhook reconcile, grants, public feed);
  - G2/G3 (charges, paywall);
  - H1 (public respond route, rules);
  - I1/I2 (open redirect, webhook HMAC);
  - J1 (outbound AI);
  - K1 (public upload and serve).
- **Rules PRs.** The rules test runs in CI (`pnpm test:rules` needs `FIREBASE_ADMIN_*`). Deploy rules and indexes from main after merge, checking open PRs first.
- **One writing agent per worktree.** A reviewer never mutates in the builder's worktree. Mutation checks run in a separate worktree, with temp dirs inside that worktree.
- **Merging.**
  - LEVEL-3 PRs (X0, A2) may merge on green CI + APPROVED blind review + security review.
  - Every HEIN-GATED PR is built to merge-ready and waits for Hein's go.

---

### Decisions for Hein (the build proceeds on the defaults)

1. **Watchdog gate.** Upstream moves the watchdog onto the new `agentsEnabledByAgency`, which would stop running watchdogs.
   - **Default:** the watchdog keeps labs + aiSuite; only stale deals use `agentsEnabledByAgency`; both show on AI Agents → Monitors.
2. **Product pay-rail order when a tenant has both Stripe and Paystack.**
   - **Default:** same order as invoices (Stripe, then Paystack), so the app has one rule. Paystack is ZAR-only.
3. **Overdue usage paywall.** Upstream walls the client workspace after a grace period.
   - **Default:** banner only. The wall ships behind an agency setting that defaults off. (Both rebilling flags also default off.)
4. **Calendar import detail.** Imported events are readable by every member under the events rules.
   - **Default:** time-only (titles and attendees stripped); a member may opt in to full details for their own calendar.
5. **AI first message on WhatsApp.** Cloud needs a template outside the 24-hour window, and cold AI texts risk bridge numbers.
   - **Default:** SMS only, as upstream.
6. **AI booking gate.** Upstream has none.
   - **Default:** no new agency gate; the per-channel booking page (unset by default) is the opt-in. Caller changes need `allowCallerChanges` (default false).
7. **Slack.** It sends client data to a third party.
   - **Default:** no agency gate; sub-account admins only; URL stored as a secret.
8. **`create_booking_page` in chat.** Ours is agent-only; upstream's monolith may expose it to chat.
   - **Default:** keep it agent-only.

### feature_list.json
```json
{"project":"crestahq-upstream-port-1.0.54","planned_at":"2026-10-29","last_session":null,
"tech_stack":["Next.js 15","TypeScript","Firestore","QStash","Paystack","Stripe","SMTP/Resend","Google Calendar","Vapi","Twilio"],
"features":[
{"id":"s1-small-fixes","priority":0,"complexity":"low","success_criteria":["relative form redirect allowed, // and /\\ refused","checkout slug 'buy' reserved","prod has 0 'buy' checkout slugs"],"passes":false},
{"id":"x0-gates","priority":0,"complexity":"low","success_criteria":["3 gates default false at both creation sites","PATCH/dialog/FEATURE_GATES/GATE_FIELDS wired","assistantMayEnable false","aiOutboundSms enable refused without readiness"],"passes":false},
{"id":"c0-imported-event-sweep","priority":0,"complexity":"medium","success_criteria":["all 30 readers skip source=google where required","push never pushes imported","mutation red"],"passes":false},
{"id":"b1-booking-changes","priority":1,"complexity":"high","success_criteria":["guard refusal writes nothing","existing reschedule/ics/call-sites tests unchanged","Playwright book-reschedule-cancel","walked on #1000"],"passes":false},
{"id":"b2-location-meet","priority":1,"complexity":"medium","success_criteria":["Meet via our push.ts, no new scope","Meet link in confirmation","gate off refuses Meet"],"passes":false},
{"id":"b3-booking-sms","priority":1,"complexity":"medium","success_criteria":["origin automated + selfTriggeredBookingAt","held reminder past start dropped","opt-out respected"],"passes":false},
{"id":"a1-agent-booking-engine","priority":2,"complexity":"high","success_criteria":["12 kept voice behaviours tested","replay finder","voice-booking-service removed, call sites moved"],"passes":false},
{"id":"a2-booking-tools-libs","priority":1,"complexity":"medium","success_criteria":["marker parser rejects forged markers","caps mutation-tested","unwired"],"passes":false},
{"id":"a3-voice-rewire","priority":3,"complexity":"high","success_criteria":["4 route test files green","changes need allowCallerChanges","test call on #1000"],"passes":false},
{"id":"a4-webchat-booking","priority":3,"complexity":"high","success_criteria":["session-scoped changes","caps enforced","widget walk on #1000"],"passes":false},
{"id":"a5-messaging-booking","priority":4,"complexity":"medium","success_criteria":["no tools on email channel","retry no double-book","quiet hours hold"],"passes":false},
{"id":"a6-ai-booking-setup","priority":5,"complexity":"medium","success_criteria":["slug validated bookable in-tenant","settings page Playwright"],"passes":false},
{"id":"c1-calendar-import","priority":2,"complexity":"high","success_criteria":["built on lib/google-calendar","no new scope or schedule","rules test: imported events read-only","time-only default"],"passes":false},
{"id":"c2-calendar-import-ui","priority":3,"complexity":"medium","success_criteria":["imported events render read-only"],"passes":false},
{"id":"d1-stale-deals-monitors","priority":2,"complexity":"medium","success_criteria":["our pipelines libs","live-mode deals only","one alert per stage visit","index deployed"],"passes":false},
{"id":"e1-slack","priority":2,"complexity":"medium","success_criteria":["publicFetch + SSRF loopback test","URL in private doc","dispatch unaffected by Slack failure"],"passes":false},
{"id":"f1-sell-online-model","priority":2,"complexity":"medium","success_criteria":["gate enforced","slug collision refused"],"passes":false},
{"id":"f2-buy-pages-stripe","priority":3,"complexity":"high","success_criteria":["chooseProductPayRail","pending order before provider","amount from doc"],"passes":false},
{"id":"f3-paystack-orders","priority":4,"complexity":"high","success_criteria":["attempt before initialize","replay one order one email","R10 live buy walked"],"passes":false},
{"id":"f4-entitlements","priority":5,"complexity":"medium","success_criteria":["deterministic ids","rules: member read, server write"],"passes":false},
{"id":"f5-product-images","priority":3,"complexity":"medium","success_criteria":["upload works without gitpage","generate 503 without key","path traversal refused"],"passes":false},
{"id":"f6-products-feed","priority":4,"complexity":"medium","success_criteria":["feed public fields only","gate off 404","dark: no GITPAGE_API_KEY"],"passes":false},
{"id":"g1-usage-meter-ui","priority":2,"complexity":"medium","success_criteria":["agency currency not usd default","overage fixtures"],"passes":false},
{"id":"g2-usage-close-charge","priority":3,"complexity":"high","success_criteria":["provider-agnostic","idempotent close","both flags required","dark"],"passes":false},
{"id":"g3-overdue-invoices","priority":4,"complexity":"high","success_criteria":["banner default, wall behind setting off"],"passes":false},
{"id":"h1-quote-signature","priority":2,"complexity":"medium","success_criteria":["rules hunk merged with paidVia/autoCharge","signed quote frozen","walked on #1000"],"passes":false},
{"id":"h2-signed-copy","priority":3,"complexity":"low","success_criteria":["one email per signature"],"passes":false},
{"id":"i1-own-pixel-click","priority":2,"complexity":"high","success_criteria":["no open redirect","unsubscribe not wrapped","off = byte-identical"],"passes":false},
{"id":"i2-resend-events-webhook","priority":3,"complexity":"medium","success_criteria":["svix raw-body verify","bounce writes suppression","dark on prod"],"passes":false},
{"id":"i3-stats-triggers","priority":4,"complexity":"medium","success_criteria":["SMTP shows not available","emailBouncedAt rule test"],"passes":false},
{"id":"j1-ai-outbound-sms","priority":3,"complexity":"high","success_criteria":["at-most-once","SMS opt-out not WhatsApp","quiet hours","dark"],"passes":false},
{"id":"k1-logo-upload","priority":2,"complexity":"low","success_criteria":["PNG/WebP only","nosniff","walked on #1000"],"passes":false},
{"id":"t-assistant-tools","priority":6,"complexity":"medium","success_criteria":["split files","FIXTURE_ARGS rows","check:tenancy","chatRefusal on enable/connect"],"passes":false}]}
```

