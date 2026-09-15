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
- **Settings CTAs deep-link to the Messaging tab.** Originally this said
  "lands on `/dashboard/settings`, not deep-linked — out of scope" — wrong,
  and caught by absence review: that page opens on the Admin tab by default,
  so email/GBP's cards (on the Messaging tab) were invisible on arrival.
  Fixed minimally: the settings page now reads `?tab=` and seeds the (still
  uncontrolled) `Tabs`'s `defaultValue` with it when it names a real tab,
  falling back to `"admin"` otherwise — see "PR #156 absence review" below.
  Email and GBP CTAs now point at `/dashboard/settings?tab=messaging`.
  WhatsApp still points at its own dedicated page
  (`/dashboard/settings/whatsapp`), unchanged.

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

## PR #156 absence review — two LOWs

**(1) Messaging-tab deep link.** `src/app/(dashboard)/sa/[subAccountId]/dashboard/settings/page.tsx`
gained a `?tab=` query param: `useSearchParams().get("tab")`, validated
against the five real tab values, seeds `Tabs`'s `defaultValue` (Base UI's
Tabs is uncontrolled, so this is read once on first render — no controlled
state, no extra re-renders). An unrecognised or missing `tab` falls back to
`"admin"`, unchanged from before. `checklist.ts`'s email/gbp hrefs now read
`/dashboard/settings?tab=messaging`.

**(2) "Not available" instead of a dead CTA.** Added `available: boolean` +
`reason: string | null` to `LaunchpadItem`. Scoped to the two items the
review named (email, GBP) — WhatsApp/booking/contacts/forms/workflows are
untouched and always `available: true`, since none of those cards self-gate
the way email and GBP do and the review didn't ask for them.

- GBP: unavailable when the viewer isn't a sub-account admin, OR
  `googleEnabledByAgency !== true` — both read straight off
  `sub-account-google-section.tsx`'s own render guard (`if (!isAdmin) return
  null;` then the gate check before the card body).
- Email: checked what `sub-account-smtp-section.tsx` actually requires —
  `isAdmin` only, no agency gate at all. So `emailDomainEnabledByAgency`
  being off never blocks setup for an admin; SMTP is always the fallback
  path. The predicate is still written as the full OR (domain option, SMTP
  option) rather than collapsed to `viewer.isAdmin`, so it keeps reading
  correctly if SMTP ever grows its own gate — but today it's unavailable
  only to a non-admin viewer.
- **Once an item is done, it stays `available: true`** regardless of the
  live gate state — a connection made before a gate was later turned off
  is a completed setup, not something to retroactively hide. This also
  means `unavailableReason` is only ever computed for a not-yet-done item,
  which is the only case with a dead CTA to replace.
- The progress denominator now excludes unavailable items:
  `total`/`done` on `launchpad-progress` are computed over
  `items.filter(i => i.available)` — an item that isn't the viewer's to do
  was never part of their "N of 7".
- Page: unavailable+not-done items render a muted `MinusCircle`, the
  `reason` text in place of the description, a "Not available" label
  instead of the "Set up" button, and no button — `data-available="false"`
  on the item wrapper.

New `LaunchpadViewer` param on `buildLaunchpadChecklist(sub, counts, viewer)`
carries only `{ isAdmin: boolean }`, read from `useSubAccount()`'s existing
`isAdmin` in the page — no new context or fetch needed.

Tests added to `checklist.test.ts` (10 new cases): email available-with-gate-off-for-admin,
unavailable-for-non-admin, stays-available-once-done; GBP unavailable-gate-off,
unavailable-non-admin-even-with-gate-on, available-admin-with-gate-on,
stays-available-once-done-even-with-gate-later-off; whatsapp always-available
sanity check. `e2e/specs/launchpad.spec.ts` gained a second test (written,
NOT run): GBP gate off + disconnected → `data-available="false"`, the reason
text visible, no "Set up" button; email domain gate off → still
`data-available="true"` (proving the SMTP-fallback read, not just the happy
path). Both checked against the E2E identity (the fixture agency owner, an
admin) — the non-admin half of each predicate has no second, non-admin login
session in this suite to drive it end to end, so that half is unit-tested
only.

Mutation-tested the two new predicates the same way as the rest (see below):
flipping `emailAvailability`'s `domainOption || smtpOption` to `&&` and
`gbpAvailability`'s gate check from `!==` to `===` both turned the relevant
availability tests red; restored, diffed clean.

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
in the branch's session log. 4502 unit/vitest tests pass (406 files),
including the 24 in `checklist.test.ts` and the 9 in `route.test.ts`.
`pnpm exec tsc --noEmit` clean across `src/` and `e2e/`. No `console.log`
added. All new files ≤300 lines (`checklist.ts` 201, `checklist.test.ts` 207,
`route.ts` 77, `route.test.ts` 125, `page.tsx` 149). The one pre-existing
file touched, `dashboard/settings/page.tsx`, was already 353 lines before
this branch (a large existing settings page, many unrelated sections) —
added 11 lines surgically for the `?tab=` fix rather than refactoring a file
outside this ticket's scope.
