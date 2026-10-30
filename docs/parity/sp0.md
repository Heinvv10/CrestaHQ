# SP0 — E2E harness + CrestaHQ tenant goes live

**Date:** 2026-09-05 · **Depends on:** nothing · **Blocks:** SP1–SP13
Programme context: [PARITY_PROGRAM.md](../PARITY_PROGRAM.md) §SP0.

SP0 delivers two things that later subprojects assume exist: a Playwright suite
that blocks merge on every PR, and CrestaHQ's own sub-account (#1000) running
live on crm.crestahq.com instead of on GoHighLevel.

---

## Decision summary (grilled 2026-09-05)

**Verdict:** Proceed with constraints.

### Decided

1. **The per-PR job tests the PR's own build, not production.** Playwright's
   `webServer` starts the PR's build on `127.0.0.1:3100` and the specs run
   against that. A second job, `e2e-smoke`, runs the same specs against
   `https://crm.crestahq.com` after a deploy. One config, two targets, selected
   by `PLAYWRIGHT_BASE_URL`.

   *Why not target production on every PR, as originally scoped:* crm.crestahq.com
   serves the last deploy, which is `main` — never the PR. A green run would prove
   nothing about the change under review, and a red one would block an unrelated
   PR because production happened to be down. That is CLAUDE.md's "gate believed
   to run and not running", in the more expensive form where the gate looks like
   the strongest in the repo.

2. **Data lives in a fixture sub-account inside the real `crestahq-app` project.**
   There is exactly one Firebase project — no staging — so the choice is real
   Firestore or the emulator. Real Firestore wins because it exercises the actual
   security rules and composite indexes, and a missing index surfacing as
   `FAILED_PRECONDITION` at runtime is a bug class this repo has already been
   bitten by. The blast radius is fenced instead: see *Fixture-tenant guard*.

3. **CI gets its env from GitHub Actions repository secrets.** Rotatable in one
   place, masked in logs, and visible to anyone reading the workflow.
   `ci.yml` already refuses fork PRs (`head.repo.full_name == github.repository`),
   so no outside PR can reach them on the self-hosted runner.

4. **The E2E identity is an agency owner — of its own dedicated E2E agency.**
   Owner rights are needed for the sub-account-switch spec, which requires more
   than one account to switch between. But `requireAgencyOwner` is agency-scoped
   (`src/lib/auth/require-tenancy.ts:66-77`) and account numbers are
   agency-scoped too, so a *separate* agency gives the suite full owner
   privileges over its own two fixture sub-accounts while making the CrestaHQ
   agency's tenants — and therefore all Blitz/Velocity/Vortex data —
   unreachable by construction rather than by convention. The suite gets
   everything an owner identity buys and nothing it risks.

5. **The enrol spec drives the step worker itself.** `/api/workflows/step` is a
   POST whose only guard is an `upstash-signature` over the raw body
   (`src/app/api/workflows/step/route.ts:26-32`). The spec signs a
   `{runId, nodeId}` body with `QSTASH_CURRENT_SIGNING_KEY` and asserts the
   *effect* — tag applied, `history[]` advanced — rather than the mere existence
   of a run document. QStash cannot reach `127.0.0.1`, so an
   enrolment-only assertion would pass against a completely broken engine.

6. **Google OAuth and per-tenant Paystack are built inside SP0** (Hein, after the
   gap below was raised). Both are absent from the codebase today.

### Proven assumptions

Verified in this repo at `ea19ac0` unless stated otherwise.

- **No E2E tooling exists.** No Playwright/Cypress/Puppeteer dependency, config
  or spec. 52 Vitest files, zero `.spec.ts`.
- **The cookie alone is not enough to authenticate the app.**
  `next-firebase-auth-edge` intercepts `/api/login` in `src/middleware.ts:308-331`
  and mints a `__session` cookie from a `Bearer <idToken>` header, which
  authenticates the *server*. But dashboard pages live-query Firestore through
  the Firebase JS SDK, whose session lives in IndexedDB — with a cookie-only
  state those pages render empty and specs fail for reasons unrelated to the
  feature under test. Global setup therefore signs in through the real form once
  and saves `storageState({ indexedDB: true })`. Found the hard way; the first
  three specs failed on it.
- **CI runs on GitHub-hosted `ubuntu-latest`**, two jobs, nothing
  `continue-on-error`. Playwright browsers are installed per run
  (`playwright install --with-deps chromium`).
- **No test-data seeder exists.** The only seeder,
  `src/lib/seed/demo-data.ts`, is hard-gated to `LANDING_VARIANT === "leadstack"`
  and targets `accountNumber === 1004`. SP0 writes its own.
- **Account numbers are agency-scoped and auto-incremented** from a transactional
  counter at `agencies/{agencyId}/counters/subAccount`, starting at 1000
  (`src/lib/server/sub-accounts-service.ts:155-272`). "#1000" means *this
  agency's first sub-account*, not a global id. The fixture tenant therefore
  takes whatever number the counter yields — **not** 1004, which the demo seeder
  already claims.

### The gap that changed the scope

Task 5 as briefed ("connect Google OAuth, Meta OAuth and Paystack TEST mode via
the real UI") was one-third buildable:

| Integration | State today | Evidence |
|---|---|---|
| **Meta OAuth** | **Exists, wired.** Connect card, redirect, callback, token storage on `subAccounts/{id}.metaConfig`. | `src/components/settings/sub-account-meta-section.tsx`, `src/app/api/sub-accounts/[id]/meta/connect/route.ts`, `src/app/api/meta/callback/route.ts` |
| **Google OAuth** | **Absent entirely.** No OAuth route, no `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, no `accounts.google.com/o/oauth2` call. The GBP page returns `<ComingSoon channelId="google-business" />`. The "Google review" card is a pasted URL; the calendar card is a read-only `.ics` feed whose own comment calls real sync "the v1.1 OAuth upgrade path". | `src/app/(dashboard)/sa/[subAccountId]/ai-agents/google-business/page.tsx` |
| **Paystack (per tenant)** | **Absent.** `grep -rli paystack src/components src/app/(dashboard)` returns nothing. One deployment-wide `PAYSTACK_SECRET_KEY` + `BILLING_PROVIDER`; test vs live is decided only by whether the key string starts `sk_test_`. | `src/lib/paystack/client.ts`, `src/lib/billing/provider.ts` |
| **Payments v1 (Stripe)** | **Exists** — paste a restricted key, stored server-only at `subAccounts/{id}/private/stripeConnection`. Gated on `paymentsEnabledByAgency`. | `src/components/settings/sub-account-stripe-section.tsx`, `src/app/api/sub-accounts/[id]/stripe-connection/route.ts` |

The recommendation was to defer Google to SP5 and per-tenant Paystack to SP9.
**Hein chose to build both inside SP0.** Recorded here so the cost is visible:
SP0 is the dependency of thirteen subprojects, and it now also contains two new
credential subsystems. Mitigation is the PR split in the DAG below — the harness
merges first and unblocks wave 1 while the integration PRs continue.

### Remaining risks

- A spec bug still writes to the production *project*, even though the dedicated
  E2E agency puts client tenants out of reach. Firestore-level accidents
  (a query without an `agencyId` filter, a rules change) remain possible.
- **The production Firebase admin key lands in GitHub's secret store** and is
  decrypted onto the velo box on every CI run.
- **Google OAuth needs a consent screen and an OAuth client on `crestahq-app`**,
  created through the Google Cloud console — browser work under Hein's login,
  not scriptable.
- **The deployment is missing the env that task 5 depends on.** Read from
  `/home/velo/crestahq/.env.production` on 2026-09-05: `META_APP_ID`,
  `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `QSTASH_TOKEN`,
  `QSTASH_CURRENT_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `PAYSTACK_SECRET_KEY` and
  `BILLING_PROVIDER` are all **absent**. Consequences:
  - Meta connect 403s `not_configured` — the button cannot work today.
  - **Workflows cannot run at all on crm.crestahq.com.** `scheduleNode` calls
    `publishCallback`, and when QStash is unconfigured that returns falsy and the
    run is set to `status: "failed"` immediately
    (`src/lib/workflows/engine.ts:897-921`); the step worker itself 503s
    (`src/app/api/workflows/step/route.ts:18-23`). So "rebuild CrestaHQ's
    workflow and have it run live" is blocked on QStash credentials, not on
    building anything.
  - The `e2e-smoke` job's enrol spec will fail against production until QStash is
    configured there. Expected, not a harness defect — the smoke job is
    non-blocking for exactly this kind of environmental gap.
- **Playwright browser binaries** are downloaded on every run (the runner is
  ephemeral).

### Execution guardrails

- Branch `feat/sp0-*` per PR, in `../CrestaHQ-wt-sp0`. Never `main`. Stage
  explicit paths — the shared checkout carries other sessions' work.
- Every gate stays blocking. The Playwright job is **not** `continue-on-error`;
  if it is too flaky to block, it gets deleted rather than softened.
- No credential in the repo. gitleaks stays a hard gate.
- Blind `/review` per PR; `review-team` if a diff passes 500 lines.
- Every spec is mutation-proven before it counts as done (below).

### Fixture-tenant guard

Four layers. Layer 0 is structural and does the heavy lifting; the rest catch
mistakes inside the fixture agency itself.

0. The E2E identity owns a **dedicated E2E agency**, not the CrestaHQ agency.
   `requireAgencyOwner`/`requireSubAccountMember` reject it for every CrestaHQ
   tenant, so client data is unreachable by construction.
1. `E2E_SUBACCOUNT_ID` names the fixture tenant; specs read only that.
2. The Playwright global setup **aborts the run** if `E2E_SUBACCOUNT_ID` is
   unset, or resolves to a sub-account whose `name` is not the fixture name.
3. Teardown deletes only documents whose `subAccountId` equals
   `E2E_SUBACCOUNT_ID`, and the delete helper throws on any document that fails
   that check rather than skipping it silently.

A test asserting that layer 3 throws when handed a foreign `subAccountId` ships
with the harness.

---

## DAG

Three PRs. Each is independently reviewable and mergeable; later ones rebase on
earlier ones.

```
SP0-A  harness           ──▶ SP0-B  integrations ──▶ SP0-C  tenant live
(blocks merge from here)     (Google OAuth,           (workflow rebuild,
                              per-tenant Paystack)     connect + screenshots)
```

| PR | Contents | Gate to merge |
|---|---|---|
| **SP0-A** | `@playwright/test`, `playwright.config.ts`, fixtures (programmatic login, tenant guard), seed + teardown script, fixture sub-account created, `e2e.yml` workflow (PR job + smoke job), GitHub secrets set | `pnpm ci:check` green · Playwright job green · gitleaks green · 5 specs mutation-proven · blind `/review` APPROVED |
| **SP0-B** | Google OAuth (consent screen, client, callback, token refresh, per-tenant storage) · per-tenant Paystack connection · specs for both | same, plus specs for the new surfaces |
| **SP0-C** | CrestaHQ workflow "Audit clicked → tag Contacted + notify" rebuilt on #1000 · Meta + Google + Paystack + Payments v1 connected on #1000 · side-by-side GHL screenshots | same, plus the browser proof attached to the PR |

Wave 1 (SP1, SP2, SP3, SP5-fixture, SP13) may start once **SP0-A** merges — it is
the harness that those subprojects depend on, not the tenant being live.

---

## Gates

| Gate | Where | Blocks |
|---|---|---|
| `pnpm lint` (tenancy check + ESLint `--max-warnings 0`) | CI | yes |
| `pnpm exec tsc --noEmit` | CI | yes |
| `pnpm test` (Vitest) | CI | yes |
| `pnpm build` | CI | yes |
| gitleaks | CI | yes |
| **`e2e` (Playwright vs the PR build)** | CI, new | **yes** |
| `e2e-smoke` (Playwright vs crm.crestahq.com) | post-deploy | no — reports |
| Blind `/review` APPROVED | before merge | yes |

---

## Mutation proofs

A spec counts as done only when a scripted mutation to production code turns it
red and reverting turns it green. Two of this repo's guards were vacuous when
written; asserting the substitution is the fix.

| Spec | Mutation applied to `src/` | Result |
|---|---|---|
| login | `createSessionCookie` returns before minting the cookie (`src/lib/firebase/auth.ts`) | **RED** |
| sub-account switch | contacts query scoped by `agencyId` instead of `subAccountId` (`src/lib/firestore/contacts.ts:76`) | **RED** |
| contact create/edit/delete | `POST /api/contacts` rejects every create (`src/app/api/contacts/route.ts:41`) | **RED** |
| form submit → contact | the persisted email is corrupted before the write (`src/app/api/forms/[id]/submit/route.ts:370`) | **RED** |
| guard (`e2e/lib/guard.test.ts`) | (a) foreign `subAccountId` accepted; (b) missing `subAccountId` accepted | **RED** in both |
| workflow enrol → action runs | `add_tag` neutered into a no-op that still reports success | **RED** (proven in CI, PR #28, closed) |

Verified 2026-09-05. Every mutation was applied by a script that aborts when its
anchor is missing or ambiguous, because a substitution that silently fails to
apply reports a green run as proof of nothing. Two earlier attempts did exactly
that and were discarded. `git status -- src/` is empty after each round.

### What the enrol spec proves, and what it does not

CI runs the app on `127.0.0.1`, which QStash can never call back. The suite's
`QSTASH_*` values are therefore **CI-only strings, not Upstash credentials** —
the spec signs the step request and the app verifies it with the same key, so no
Upstash round trip is involved. The spec then hands the parked run back to
`running`, which is precisely what a successful QStash delivery would have left
behind.

**Proven:** the trigger fired on form submission, the run document is bound to
the right workflow/contact/tenant, the *signed* step worker authenticates, and
`add_tag` lands on the contact with `history[]` advanced.

**Not proven:** that `scheduleNode`'s publish to QStash succeeds. That link is
unprovable from CI while the app is on loopback. Pointing a real QStash token at
`127.0.0.1` would prove no more than this does, while accruing undeliverable
retries against the production quota — so it is deliberately not done. The
`e2e-smoke` job against crm.crestahq.com is where the publish becomes provable,
once that deployment has QStash configured. **Today it does not**, so smoke
remains red on that spec, which is a real finding about the deployment rather
than a harness defect.

---

## Parity ledger

| GHL screen / behaviour | Observed in GHL | CrestaHQ today | Gap | Spec that proves it | Status |
|---|---|---|---|---|---|
| Login | — | `/login`, Firebase + `__session` | none | `e2e/specs/login.spec.ts` | **green, mutation-proven** |
| Sub-account switch | Agency view → account picker | `/agency/sub-accounts` list → `/sa/{id}` | no in-page switcher; navigation only | `e2e/specs/switch-subaccount.spec.ts` | **green, mutation-proven** |
| Contact create / edit / delete | Contacts | `/sa/{id}/contacts` | — | `e2e/specs/contacts.spec.ts` | **green, mutation-proven** |
| Form submit → contact | Forms | `/f/{formId}` → contact write | — | `e2e/specs/form-submit.spec.ts` | **green, mutation-proven** |
| Workflow enrol → action runs | Automation | `fireWorkflowTrigger` → `workflowRuns` → signed step worker | publish leg unprovable on loopback; prod has no QStash | `e2e/specs/workflow-enrol.spec.ts` | **green, mutation-proven; smoke red until prod QStash** |
| Google account connected | Settings → Integrations | `/api/google/callback`, tokens at `subAccounts/{id}/private/googleConnection` | code shipped (#32); `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` **not on the deployment**, so the card cannot complete a connect in production | SP0-B | **code merged, not live** |
| Paystack connected per tenant | Payments | `/api/sub-accounts/{id}/paystack-connection`, secret at `subAccounts/{id}/private/paystackConnection` | code shipped (#31); no tenant was connected through it in SP0, so `webhookSeenAt` is expected to be unset — not read back from Firestore to confirm | SP0-B | **code merged, not live** |
| Meta connected | Settings → Messaging tab | connect card + `page` / `instagram` webhook subscriptions registered | `META_APP_ID` / `META_APP_SECRET` set on the deployment; Meta **App Review not submitted by SP0** — that is an outward-facing submission and stays with Hein. Review state is not verifiable from this repo; check it in the Meta dashboard | SP0-C | **wired; blocked on App Review** |
| Async work runs at all | — | QStash | `QSTASH_TOKEN` + both signing keys now set on the deployment and proven end to end | `e2e/specs/workflow-enrol.spec.ts` (smoke) | **fixed — was a live production defect** |
| Logged-out redirect | — | `loginRedirectUrl` in `src/middleware.ts` | was sending users to `http://localhost:4300/login`; now derives the origin from `NEXT_PUBLIC_APP_URL`, with a post-build assertion in `scripts/deploy-velo.sh` | `e2e/specs/logged-out-redirect.spec.ts` | **fixed and verified in production (#38)** |
| Agency owner lands on `/agency` | Agency dashboard | race: `agencyRole` has no `userDoc` fallback when the token refresh fails | real defect, deliberately not fixed in SP0 | `e2e/specs/owner-lands-on-agency.spec.ts` (`test.fixme`) | **documented, open** |
| CrestaHQ workflow live | 1 published workflow | to rebuild | — | SP0-C | pending |

A row is done only when the last two columns are filled and the spec is green in
CI.

---

## Needs Hein

Blocking items that cannot be resolved from the repo. Items 4 and 5 of the
original list are **done** — the Meta app credentials and all three QStash
credentials are now on the deployment.

1. **Stripe restricted TEST key** (`rk_test_…`/`sk_test_…`) for the Payments v1
   connection on #1000. A live key will be refused.
2. **Paystack TEST secret key**, to connect a tenant through the card shipped in
   #31. The code is merged; nothing is connected.
3. **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the deployment.** The OAuth
   code merged in #32 and the callback is deployment-wide, but the two
   credentials are absent from `/home/velo/crestahq/.env.production`, so the
   connect button cannot complete a round trip in production.
4. **Meta App Review submission.** The app is wired — credentials set, `page`
   and `instagram` webhooks registered, icon and copy filled in — but submitting
   for review is an outward-facing action and was deliberately left to Hein.
5. **Which agency feature gates are on for #1000** — `paymentsEnabledByAgency`,
   `metaInboxEnabledByAgency`, `socialPlannerEnabledByAgency` all default false,
   and each connect card is invisible until its gate is on.

---

## Where SP0 stands

**SP0-A (harness) is done.** Playwright runs on every PR against the PR's own
build, blocks merge, and every spec in the table above was proven by mutation —
the production code was broken and the spec went red.

**SP0-B (integrations) is code-complete and partly live.** QStash is live and
proven. Google and Paystack are merged but need credentials before a tenant can
actually connect.

**SP0-C (tenant live) has not started.** Rebuilding CrestaHQ's own published
workflow, and the side-by-side GHL screenshots, are the remaining work.

### Deployed

`3ee48a3` on crm.crestahq.com (port 4300, systemd user service `crestahq`),
deployed 2026-09-06. The logged-out redirect was verified against the public
origin after the deploy rather than assumed:

```
$ curl -sI https://crm.crestahq.com/agency | grep -i location
location: https://crm.crestahq.com/login?redirect=%2Fagency
```

### Two live defects SP0 found

Neither was visible in code review; both surfaced the first time something was
actually run against the deployment.

1. **QStash was absent from production.** All 20 `publishCallback` /
   `publishSocialPost` call sites, across 17 files, were dead — no workflow
   step, reminder or broadcast could ever have fired. Green CI throughout,
   because CI supplies its own keys.
2. **Logged-out users were redirected to `http://localhost:4300/login`.** Not a
   `Host`-header problem: under the standalone server systemd sets
   `HOSTNAME=127.0.0.1`, and `request.nextUrl` is derived from that bind address
   rather than from the incoming `Host` — an explicit
   `Host: crm.crestahq.com` still produced localhost. Fixed in #38 by pinning
   the origin to `NEXT_PUBLIC_APP_URL`, and guarded at deploy time by asserting
   the built middleware chunk actually contains that origin — the value is
   constant-folded at build time, so a shell-env check would have passed on a
   bad artifact. See the comment on `loginRedirectUrl` in `src/middleware.ts`
   for the full mechanism.
