# LeadStack CRM

A production-ready, all-in-one CRM styled after GoHighLevel and HubSpot, scoped for
small teams. It is sold as a **white-label template**: a buyer generates their own
private repo from `Claude-Code-Pro-Camp/leadstack-agency`, brands it via
`CUSTOM_BRAND` in `src/config/landing.ts`, and sells it on as their own product.
Every external dependency is a user-provided credential; the repo embeds no secrets.

`LeadStack` is just the name of this codebase — substitute the buyer's brand
wherever it appears in user-facing copy.

> **Two audiences, two deploy targets — do not mix them up.**
> *This* repo (`/home/hein/Workspace/CrestaHQ`) is the product being built, and it
> deploys to **velo-server** via `scripts/deploy-velo.sh` (systemd `crestahq`, port
> 4300). **Buyer copies** deploy to **Vercel** — that path is documented for them in
> [SETUP.md](SETUP.md) and [docs/onboarding-buyer.md](docs/onboarding-buyer.md), and
> is never the target of work done here.

*Last reviewed: 2026-09-04.* When a rule below is corrected in a session, update this
file in the same PR. Feature specs live under `docs/` — new subsystem detail belongs
there, not here. If this file passes ~300 lines, something has been added that should
have been a link.

---

## How to work here

**Think before coding.** State assumptions out loud rather than picking silently.
Where a request has two readings that lead to materially different work, say both and
ask. If a simpler approach exists, say so — including when it contradicts what was
just asked for. Caving to the last thing said is worse than being wrong out loud.

**Simplicity first.** Write the minimum code that solves the stated problem. No
abstraction for a single caller, no configurability nobody requested, no error
handling for impossible states. Before "properly" abstracting something a review
suggested, grep for actual usage. If 200 lines could be 50, rewrite it.

**Surgical changes.** Every changed line traces to the request. Don't reformat,
rename, or improve adjacent code; match surrounding style even where you'd differ.
Pre-existing dead code gets *mentioned*, not deleted. Remove only what your own
change orphaned.

**Verify, don't claim.** Run the check in the message where you claim success.
"Should work", "looks right", and "Done!" without output are not evidence. Turn a
task into a verifiable goal first ("add validation" → "write tests for the invalid
inputs, then make them pass"), then loop until the check passes.

**Debugging:** instrument at each component boundary before proposing a fix. After
three failed attempts, stop and question the architecture — the bug is not where you
think it is.

---

## Development workflow — branch, review, merge, deploy

**Never commit to `main`.** First action of any code task is a branch
(`feat/…`, `fix/…`, `ci/…`, `docs/…`). Everything lands through a PR.

### The gates

| Gate | Where | Blocks? |
|---|---|---|
| `pnpm lint` (tenancy check + ESLint) | CI + `deploy-velo.sh` | yes |
| `pnpm exec tsc --noEmit` | CI + deploy | yes |
| `pnpm test` | CI + deploy | yes |
| `pnpm build` | CI + deploy | yes |
| gitleaks secret scan | CI | yes |
| Blind `/review` | you, before merge | yes |

`pnpm ci:check` runs the first four locally — byte-for-byte the same commands
CI runs, so a green local run means a green pipeline. Keep them identical; a
`npx` here and a `pnpm exec` there is the first millimetre of the same drift
that let FibreFlow's baselines diverge across five files.

**Nothing in CI is `continue-on-error`, and nothing should become so.** The
entire gate takes ~52s, so there is no speed argument for softening a step. If
a step is too slow or flaky to block, delete it instead — a gate believed to
run and not running is worse than no gate, because it buys false confidence.
(FibreFlow's unit tests were `continue-on-error` while a deadlocked suite
reported green for months.)

**There is no warning cap to drift.** `pnpm lint` runs at `--max-warnings 0`,
and `eslint.config.mjs` honours the `_`-prefix convention the code already
uses, so "deliberately unused" is expressed in the code rather than absorbed
into a budget. A cap is a one-way ratchet: fix one warning and it silently
grows slack for the next. Zero has no slack.

If a cap ever becomes unavoidable, it lives in exactly ONE place — the `lint`
script — and is never copied into a workflow, a deploy script or a doc.
FibreFlow ended up with the same baseline in five files, drifted apart, with the
CI copy so loose the gate could not fail; they now run a second gate whose only
job is guarding the first. The way to never need that is to never write the
number twice.

### Working in a shared checkout

**Several Claude sessions may share `/home/hein/Workspace/CrestaHQ` at once.**
Assume another session's uncommitted work is sitting in the tree beside yours.

- **Never `git add -A` or `git add .`** — stage explicit paths. On 2026-09-04
  an `add -A` swept a concurrent session's 490-line snapshot change into a PR
  about WhatsApp templates. CI was green and the blind review was genuine, but
  the review had been aimed at templates and never examined the snapshot work
  — merging would have taken unreviewed code to `main` under a review that did
  not cover it. Caught only by reading `git log` before the merge.
- **Check `git log --oneline origin/main..HEAD` before opening a PR.** Every
  commit on the branch should be one you wrote. A commit you do not recognise
  belongs to another session.
- **Use a worktree when you need to switch branches**
  (`git worktree add ../CrestaHQ-wt-<name> -b <branch> origin/main`). Switching
  branches in the shared checkout moves it under whoever else is working there.
- **Never rewrite or force-push a branch carrying someone else's commits.**
  Cherry-pick your own onto a clean branch and leave theirs alone.

### Review — never review your own code

Always dispatch a blind `/review`: a fresh agent that gets the diff and the
CLAUDE.md rules, and none of the implementing session's reasoning. Use
`review-team` for 500+ line diffs. Report findings verbatim; verify each one
against the actual file before accepting or disputing it.

This is not ceremony. On 2026-09-03 the WhatsApp provider seam passed lint,
typecheck, 355 tests and a real build — and blind review still found two HIGHs:
a Twilio-only readiness gate that made the new Cloud rail unreachable, and four
of five send paths bypassing the seam entirely. CI cannot catch "correctly
built, wired to the wrong thing." Review can.

### Merging — the Level-3 boundary

With **green CI + an APPROVED blind review**, work may merge without Hein
reading the diff, provided all of: greenfield or additive, not customer-facing,
touches no live client data, and objectively verified by tests that fail when
the code is wrong.

Outside that boundary a human gate stands regardless of how green CI is:
outbound customer communication, live client data, production deploys, spending
money, irreversible external actions.

Merge with `gh pr merge <N> --merge --delete-branch` — a real merge commit, so
the PR's individual commits stay readable in history.

### CI runner

CI runs on a **self-hosted runner** (`velo-crestahq-u`, labels
`self-hosted, linux, velo, crestahq`) because GitHub-hosted runner billing is
paused on this account. It runs as its own unix user (`gha-crestahq`) under
`actions.runner.Heinvv10-CrestaHQ.velo-crestahq-u.service`, matching the four
sibling runners on the same box. If PRs sit queued forever, check that service
first — a stopped runner looks exactly like a slow CI.

### Deploy

`bash scripts/deploy-velo.sh` — run ON velo-server, from the deploy checkout.
Gates run before the service is touched, so a failed build can never leave a
half-served app returning 500s. Production deploys are refused inside business
hours (08:00–17:00 SAST, Mon–Fri); `--force` overrides **the time window only**,
never the gates. The deploy dir is a target, not a workspace — the script
refuses to run against a dirty checkout.

---

## Commands

- `pnpm dev` — dev server (Turbopack)
- `pnpm build` — production build
- `pnpm start` — production server
- `pnpm lint` — tenancy check then ESLint at `--max-warnings 0`
- `pnpm test` / `pnpm test:watch` — Vitest
- `pnpm ci:check` — lint + typecheck + test + build, exactly as CI runs them
- `pnpm check:tenancy` — [scripts/check-capability-tenancy.mjs](scripts/check-capability-tenancy.mjs):
  fails when an AI Suite capability's `execute` lacks a visible tenant anchor.
  **Adding a capability means making this pass** — see
  [docs/architecture/key-architecture.md](docs/architecture/key-architecture.md).
- `pnpm doctor` — env-var shape check (`--live` also probes Firebase)
- `pnpm format` — Prettier
- `firebase deploy --only firestore:rules,firestore:indexes` — **run after any
  collection or index change.** Deploying rules alone silently skips indexes, and
  the missing composite surfaces at runtime as `FAILED_PRECONDITION`.

---

## Stack

Next.js 15 (App Router, Turbopack) + TypeScript · Firebase Auth
(`next-firebase-auth-edge` session cookies + custom claims) · Cloud Firestore
(tenancy-scoped rules) · Stripe (+ Paystack for ZAR Client Billing) · Resend ·
Twilio · OpenRouter (default `anthropic/claude-haiku-4-5`) · Vapi (voice) ·
Firecrawl · QStash (all scheduled work) · Tailwind v4 + shadcn/ui · Mapbox ·
`@dnd-kit` · `@tanstack/react-table` · pnpm.

`src/config/landing.ts` exports `CUSTOM_BRAND`; the root landing page reads every
string from it. Edit it before any buyer deploy.

---

## Architecture

Read the relevant file before changing that subsystem — these carry the invariants
that are expensive to rediscover:

- **[Auth & tenancy model](docs/architecture/auth-and-tenancy.md)** — agency →
  sub-account hierarchy, roles, custom claims, and the `agencyId` / `subAccountId` /
  `createdByUid` keys **every** tenant doc must carry.
- **[Agency feature gates](docs/architecture/feature-gates.md)** — the
  `*EnabledByAgency` booleans, their defaults, and the 5-step wiring pattern every
  new gate must follow (schema → creation defaults → PATCH branch → runtime 403 →
  manage-dialog checkbox → `FEATURE_GATES` entry).
- **[Key architecture](docs/architecture/key-architecture.md)** — page-width
  convention, client/admin SDK split, middleware public paths, the always-on form
  spam guard, shared-sender comms, usage counters, attribution capture.
- **[Firestore collections](docs/architecture/firestore-collections.md)** — every
  collection, its scope, and who may write it.
- **[Project structure](docs/architecture/project-structure.md)** — the annotated
  `src/` tree.

**Page width:** every dashboard page wraps *all* its top-level returns (including
loading / locked / empty / not-found states) in a centered container — `/agency/*`
uses `max-w-5xl`; `/sa/[id]/*` uses `max-w-5xl` for data surfaces and `max-w-3xl` for
forms, settings, and chat. Pipeline and Conversations are the only full-bleed pages. Don't invent a new
width — the one carve-out (`max-w-6xl` for an agency page whose tables genuinely need
the columns) and the full rule are in
[docs/architecture/key-architecture.md](docs/architecture/key-architecture.md).

---

## Features

Full index with links: **[docs/features/README.md](docs/features/README.md)**.

Specs: [AI Agents](docs/features/ai-agents.md) ·
[Snapshots](docs/features/snapshots.md) ·
[Workflows](docs/features/workflows.md) ·
[Quotes](docs/features/quotes.md) ·
[Products + Invoices](docs/features/products-invoices.md) ·
[Client Billing](docs/features/client-billing.md) ·
[Booking pages](docs/features/booking-pages.md) ·
[Public API](docs/features/public-api.md) ·
[Broadcasts](docs/features/broadcasts.md) ·
[Social Planner](docs/features/social-planner.md) ·
[Website builder](docs/features/website-builder.md) ·
[Labs watchdog](docs/features/labs-watchdog.md) ·
[Webinar1](docs/features/webinar1.md) ·
[Get Leads](docs/features/get-leads.md) *(parked)*.

Locked scopes for in-flight work live in the `*_V1_PLAN.md` files at the repo root.

---

## Setup & operations

- **[docs/environment.md](docs/environment.md)** — every environment variable, what
  breaks without it, and the optional in-app guided-setup form.
- **[SETUP.md](SETUP.md)** — the buyer-facing setup walkthrough (the supported path).
- **[docs/onboarding-buyer.md](docs/onboarding-buyer.md)** — the Claude-driven
  version of that walkthrough, plus the troubleshooting catalog.
- **[RUNBOOK.md](RUNBOOK.md)** — operating the deployed app.
