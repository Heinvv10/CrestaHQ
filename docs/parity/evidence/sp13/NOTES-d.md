# SP13 (d) — Launchpad evidence notes

Per-sub-account setup checklist (GHL "Launchpad" parity). Page:
`src/app/(dashboard)/sa/[subAccountId]/launchpad/page.tsx`. Pure predicates:
`src/lib/launchpad/checklist.ts` (+ `checklist.test.ts`, 18 unit tests, all
mutation-tested — see below). Counts: `GET /api/sub-accounts/[id]/launchpad`
(Admin SDK; `workflows` denies client reads, so every count goes through this
one route rather than mixing client + server reads). Sidebar entry added
directly after Dashboard.

## What each item reads (no stored progress flag anywhere)

| Item | Source | Predicate |
|---|---|---|
| Connect email sending | `SubAccountDoc.emailProvider` / `smtpConfig` / `resendConfig` | SMTP: `smtpConfig.verifiedAt` truthy. Else: `resendConfig.status === "verified"` |
| Connect WhatsApp | `whatsappSenderConfigured(subAccount)` (Twilio + Cloud + bridge, whichever rail is active) | Computed in the API ROUTE, not the pure module — see "PR #156 review fix" below |
| Connect Google Business Profile | `googleConnectionMeta` | `connected === true` — mirrors `sub-account-google-section.tsx`'s own `connected` |
| Set up calendar/booking | `subAccounts/{id}/bookingPages` count OR any `subAccounts/{id}/private/googleCalendar_{uid}` with `status === "connected"` | count > 0 OR any connected |
| Import contacts | `contacts` where `subAccountId==` | count > 0 |
| Create a form | `forms` where `subAccountId==` | count > 0 |
| Activate a workflow | `workflows` where `subAccountId==`, filtered to `status === "active"` in memory | count > 0 |

## Decisions

- **Email predicate departs slightly from the literal task wording.** The
  task said "smtpConfig present"; I used `smtpConfig.verifiedAt` truthy
  instead, because `sub-account-smtp-section.tsx` (the SMTP card itself) only
  calls SMTP the "active provider" once it holds verified credentials — the
  connect route verifies TLS/auth before writing `smtpConfig` at all, so in
  practice this is nearly the same check, but reading `verifiedAt` matches
  what the real card calls "connected" rather than "a record exists".
- **GBP predicate uses `connected === true`, not `connected && !reconnectRequired`.**
  The task said "same predicate as its settings card" — the settings-tab card
  (`sub-account-google-section.tsx`, the one actually reachable from the
  Launchpad's CTA) reads `connected` alone; the stricter
  `connected && !reconnectRequired` belongs to the AI Agents Google Business
  panel and Reputation overview, a different card. Used the one the CTA
  actually lands on.
- **No composite index added.** `workflows` has no `(subAccountId, status)`
  index today (confirmed against `firestore.indexes.json`); rather than add
  one for this feature alone, the route reads `status` for every workflow in
  the sub-account (a small, admin-managed list) via `.select("status")` and
  filters in memory. Same reasoning applied to skip aggregate `count()` for
  that one query.
- **Google Calendar "connected" has no member-readable summary field** — only
  the per-member, credential-bearing `private/googleCalendar_{uid}` doc. The
  route reads that subcollection (Admin SDK, small) and treats the item as
  done if ANY member has a connection with `status === "connected"` — the
  item is "can this workspace's bookings reach a calendar", not "did the
  current caller connect one".
- **Settings CTAs land on `/dashboard/settings` (Messaging tab) for email and
  GBP**, not a deep-linked tab — that page has no query-param tab routing
  today (`Tabs defaultValue="admin"`, no `useSearchParams`), and adding one
  was out of scope for this ticket. WhatsApp has its own dedicated page
  (`/dashboard/settings/whatsapp`) so that CTA does deep-link.

## PR #156 review fix — WhatsApp missed the Twilio rail

The original `checklist.ts` computed `whatsappConnected` from
`whatsappCloudMeta`/`whatsappBridgeMeta` only, re-implementing (badly) what
`lib/comms/whatsapp/sender-configured.ts` already owns. A Twilio-only
workspace carries neither meta field, so it read as never set up — HIGH,
caught in blind review.

Fixed by moving the predicate out of the pure module entirely: the route
(`route.ts`) now reads the sub-account doc and calls the real
`whatsappSenderConfigured()`, returning `whatsappConnected: boolean` as part
of `LaunchpadCounts`. `checklist.ts` no longer carries `whatsappCloudMeta` /
`whatsappBridgeMeta` in `LaunchpadSubAccount` at all — the whatsapp item just
reads `counts.whatsappConnected`. This also means a future fourth rail only
needs `sender-configured.ts` to know about it; the checklist can't drift.

Checked whether the same "call the feature's own helper" rule applies to
email: the closest candidate, `emailIsConfigured()` in `lib/comms/resend.ts`,
answers a different question — "can this deployment send at all" (true
whenever `RESEND_API_KEY`/`EMAIL_FROM` env vars are set, which is every
production deployment) — not "did THIS workspace connect its own sender".
Reusing it would make the email item read "done" for every sub-account
regardless of setup, which is worse than the current SMTP/resend-domain
check, so the email predicate is unchanged. Left as a callout since the
reviewer asked explicitly.

New tests: `route.test.ts` (Twilio-only, Cloud-only, bridge-only, none, and a
leftover-Twilio-meta-after-migrating-to-Cloud case — all against the real
`whatsappSenderConfigured` through a real route) plus
`src/test/memory-firestore.ts` gained `.count()` support (it had none; the
route uses `.count().get()` on four collections) so the route could be tested
against the same in-memory Firestore fake other API route tests use, instead
of a one-off harness.

## Mutation testing (every predicate, restored after each)

Ran `pnpm vitest run src/lib/launchpad/checklist.test.ts` against each
mutation below, confirmed red, then restored the file (diffed clean against
the original afterward):

1. `emailConnected`: SMTP branch forced `return true` → 1 test failed.
2. `emailConnected`: Resend branch forced `return true` → 3 tests failed.
3. `whatsappConnected`: `||` → `&&` → 2 tests failed.
4. `gbpConnected`: `connected === true` → `!!googleConnectionMeta` (truthy
   object instead of the boolean) → 1 test failed.
5. `calendar` item: `||` → `&&` → 2 tests failed.
6. `contacts` item: `> 0` → `>= 0` → 2 tests failed.
7. `forms` item: `> 0` → `>= 0` → 2 tests failed.
8. `workflows` item: `> 0` → `>= 0` → 2 tests failed.

All 8 caught; none passed dirty.

Also mutation-tested the regression the review specifically flagged: reverted
`route.ts`'s `whatsappConnected` to the OLD two-rail check
(`!!(whatsappCloudMeta?.phoneNumberId || whatsappBridgeMeta?.displayPhoneNumber)`)
and ran `route.test.ts` — the "Twilio-only" case went red (`expected false to
be true`), all 8 others stayed green. Restored, diffed clean.

## What would need to happen in production for each E2E assertion to go red

`e2e/specs/launchpad.spec.ts` (written, NOT run per instructions):

- **GBP item / progress count**: any regression that stops the page reading
  `SubAccountDoc.googleConnectionMeta` live (e.g. the page caching a stale
  snapshot, or the checklist module's `gbpConnected` predicate regressing to
  one of the mutations above) turns the false→true assertion red. A
  regression in the progress bar's `data-done` count (wrong `done` filter,
  double-counting, or not re-rendering on the subAccount doc's `onSnapshot`
  update) turns the "+1" assertion red without necessarily failing the item
  assertion itself — that's why both are asserted separately.
- **Contacts item**: any regression that stops the `contacts` count query
  scoping to `subAccountId` (e.g. an accidental global count, or the API
  route's Admin SDK auth check being bypassable so it double-counts another
  tenant) would make the fixture's baseline count wrong and could mask a
  real false→true flip. A regression in the launchpad API route itself
  (wrong collection name, dropped `where` clause, off-by-one in the `count()`
  read) turns the assertion red directly.

## Gates

`pnpm ci:check` (lint + typecheck + test + build) green — see command tails
in the branch's session log. 4487 unit/vitest tests pass, including the 18 in
`checklist.test.ts`. `pnpm exec tsc --noEmit` clean across `src/` and `e2e/`.
No `console.log` added. All new files ≤300 lines
(`checklist.ts` 133, `checklist.test.ts` 148, `route.ts` 66, `page.tsx` 138).
