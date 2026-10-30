# A1 unit-builder report — 2026-10-30

Branch: `feat/port154-a1-agent-booking`.
Worktree: `/home/hein/Workspace/CrestaHQ-wt-a1`.
Base: `origin/feat/port154-b3-booking-sms` at `6f443a2d`.
Upstream reference: `18d51837` → `bceae0fc`.
The final commit SHA is supplied with this report in the session response.

## Files

- Replaced `src/lib/server/voice-booking-service.ts` with `agent-booking-service.ts`;
  added sibling `agent-booking-types.ts`, `agent-booking-queries.ts` and
  `agent-booking-follow-ups.ts` (all under 300 lines).
- Moved `voice-booking-service.test.ts` to `agent-booking-service.test.ts`;
  added `agent-booking-behavior.test.ts` and `agent-booking-guards.test.ts`.
- Mechanically migrated the Vapi LLM route import/input names and its four test
  doubles; preserved its tool loop, mystery-shop, model fallback, contact context
  and call-id behavior. The expanded tool loop remains A3's scope.
- Migrated `google-calendar/{call-sites,external-busy}.test.ts`, explicitly seeding
  tenant-owned contacts now that the service refuses missing/foreign contacts.
- Updated the source-name comment in `calendar/appointment-filters.ts`, the
  voice-booking knowledge-base card, `docs/features/ai-agents.md` and
  `docs/architecture/firestore-collections.md`.

## Adaptations from upstream

- Kept OUR `resolvePageAvailability` / `assignBookingHosts` engine: collective
  intersections and `hostUids`, round-robin-only load balancing, named host
  selection, moving minimum notice, Google busy, long events, date overrides and
  day caps. Service pages remain refused for new bookings.
- Adopted the upstream shared channel/input/result API, channel-specific notes and
  creator ids, bounded intake/address/locationPhone inputs, contact blank-filling
  with `normalizePhoneLenient`, recent-booking finder and changeable-booking reads.
- Used our Google busy/push APIs, including B2's bounded Meet push and pinned
  late-link recipient; retained the voice after-response push. Used our ICS
  generator rather than the upstream attachment module that does not exist here.
- Retained BOTH booking triggers, tenant-scoped activity input, notifications for
  EVERY collective host, phone-call attempted/booked stamps and after-response
  contact-created emission. Phone still sends no customer confirmation/reminder.
- Non-phone confirmations use tenant SMTP/Resend via `emailIsConfigured(sub)` and
  `sendEmail({subAccount, meter})`; SMS uses B3's fixed-content builder, create-only
  per-event confirmation claim, held-confirmation note and reminder scheduler.
  No booker address/intake/locationPhone is placed in SMS. Conversational bookings
  do not claim the public-page quiet-hours exemption.
- Read assigned hosts/duration from the stored event for reschedule slots and use
  our moving-event resolver; do not pool onto another host or block the old slot.
  Existing scheduled bookings may still be listed/changed when their page is now
  unpublished or paid; this does not permit a new booking on that page.
- All path ids validate before reads; tenant/contact/page ownership fail closed.
  Logs use fixed failure labels or error names, never raw SDK objects or messages.

## Decisions beyond the plan

1. Added deterministic event ids scoped to tenant/page/channel/contact-or-call/start,
   transactional `create`, and stable phone-contact ids. Concurrent retries return
   one event and run follow-ups only on the creating request. This is stronger than
   upstream's read-only recent-booking finder. The new contact is created in the
   SAME transaction, so slot failures do not leave orphan contacts.
2. Re-read page/contact inside the transaction. Refuse if page configuration changed
   since preparation; caller-held page objects cannot bypass publish/payment/type
   guards. Non-phone channels always require a reconciled tenant-owned contact.
3. Split the shared service into four modules to respect the 300-line convention.
4. A deterministic booking that was moved/cancelled is refused rather than replayed
   as success. Rebooking the exact same page/channel/contact/start after cancellation
   is therefore refused; a different start works. Follow-ups are at most once, so
   a process failure after commit can leave them incomplete; there is no new outbox.

## Verification

All commands used Node 22.23.1 and real `pnpm install` (no node_modules symlinks).

- `pnpm lint`: exit 0, including tenancy (138 capabilities), WhatsApp rail, CORS
  and agent coverage (416 route files).
- `pnpm exec tsc --noEmit`: exit 0.
- Vitest over ALL tests in the touched directories (`src/lib/server`,
  `src/lib/google-calendar`, `src/lib/calendar`, `src/lib/ai-suite`, Vapi LLM route):
  **172 files / 2,487 tests passed**.
- Additional `src/lib/booking` suite: **33 files / 466 tests passed**.
- Dedicated A1 suites: **43 tests passed**, including all 12 retained behaviors
  (Google fail-open behavior also covered by the Google directory suite).
- `git diff --check`: exit 0.
- `ci:check` tail: NOT RUN, as explicitly required by the 1.0.54 override. Full
  build/rules/E2E checks belong to the future PR's CI, not this builder session.

### Mutation evidence

Mutations ran ONLY in `/home/hein/Workspace/CrestaHQ-wt-a1-mutations`, an isolated
worktree with a separate real pnpm install. **44 distinct mutations went red**;
all restored afterward, and the restored dedicated suites passed again.

- Offered-slot minimum notice; collective intersection; named-host narrowing;
  round-robin load; assigned-only change slots; every collective host notified;
  voice Google push; `event_confirmed`; booking SMS deterministic claim.
- Document-id guards for sub-account, agency, contact, call, page and change-event
  ids; publish/payment/service refusal; page/workspace agency and tenant checks;
  reconciled contact requirement; future start; transactional page/contact checks.
- Changeable-booking contact/tenant/source/state/future/page scopes; reschedule
  tenant/page/source/state/departed-host checks; deferred follow-up contact scope.
- Replay age/start/source/window, create-only idempotence and moved-event refusal;
  tenant email readiness.

Initial mutations exposed missing fixture coverage for page agency, non-finite
replay windows, cross-tenant reschedule and manual-source reschedule. Strengthened
those tests, reran those mutants and observed red for each. No surviving mutant.
Local evidence: `/tmp/a1-{directory-final,booking-tests,lint-final,tsc-final2}.log`,
`/tmp/a1-mutation*-results.json`, `/tmp/a1-restored-tests.log` and individual
`.mutation-*.log` files in the mutation worktree.

## Unverified / next owner

- No live provider calls, real emails/SMS, live customer data, browser session or
  live voice call. **NOT runtime-verified; NOT browser-verified.**
- No new routes/UI, Firestore rules, indexes, schema migrations or env variables.
- A3–A6/T1 remain separate units; website/messaging adapters are not wired here.
- No blind review or breaker review: the builder must not review its own work.
  A fresh session C, then D (recommended for A1), must independently assess the
  final commit. No SHIP verdict is claimed by this builder.
- No PR opened, merge or deploy. Parent B3 follow-ups remain outside A1's scope.
