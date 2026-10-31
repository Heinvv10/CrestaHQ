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
> deploys to **velo-server** via `scripts/deploy-velo.sh` (blue/green: systemd
> `crestahq-proxy` on port 4300 in front of `crestahq@4301` / `crestahq@4302`). **Buyer copies** deploy to **Vercel** — that path is documented for them in
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

Full text (gates table, shared-checkout incident notes, CI runner, deploy detail):
[docs/agent-workflow.md](docs/agent-workflow.md). Read it before your first PR. Rules that always hold:

- **Never commit to `main`.** First action of a code task is a branch (`feat/…`, `fix/…`, `ci/…`, `docs/…`); everything lands via PR.
- `pnpm ci:check` = the CI gate (lint, `tsc`, test, test:rules, build). Keep local and CI commands byte-identical. **Nothing in CI is `continue-on-error`** — delete a step rather than soften it. **No lint warning cap** (`--max-warnings 0`); if a cap is ever unavoidable it lives only in the `lint` script, never copied elsewhere.
- **Several sessions share `/home/hein/Workspace/CrestaHQ`.** Never `git add -A` / `git add .` — stage explicit paths. Check `git log --oneline origin/main..HEAD` before a PR (every commit must be yours). Use a worktree (`git worktree add ../CrestaHQ-wt-<name> -b <branch> origin/main`) to switch branches. Never rewrite or force-push a branch carrying someone else's commits.
- **Never review your own code.** Dispatch a blind `/review` (`review-team` for 500+ line diffs); report findings verbatim and verify each against the file.
- **Merge:** green CI + APPROVED blind review may merge without Hein reading the diff only if the work is greenfield/additive, not customer-facing, touches no live client data, and is verified by tests that fail when wrong. Outbound customer communication, live client data, production deploys, spending money and irreversible external actions always keep a human gate. Merge with `gh pr merge <N> --merge --delete-branch`.
- CI runs on GitHub-hosted `ubuntu-latest`, E2E and `e2e-smoke.yml` included. Those two share production fixture tenants that each run purges, so their suite job runs under a cross-run mutex (`scripts/ci/fixture-lock.mjs`, git ref `refs/ci-locks/e2e-fixtures`) that waits rather than cancels. The lock is taken and released in separate jobs (`E2E fixture lock` / `E2E fixture unlock`) that alone hold the write token; a lock job stuck on "waiting for the fixture lock" names the holder run in its log. Re-run ALL jobs, never "re-run failed jobs" — the suite job refuses to start without this attempt's lock.
- **Deploy:** `bash scripts/deploy-velo.sh`, run ON velo-server from the deploy checkout. Production deploys are refused 08:00–17:00 SAST Mon–Fri; `--force` overrides **the time window only**, never the gates. The deploy dir is a target, not a workspace (script refuses a dirty checkout). `--rollback` switches back; layout in [RUNBOOK.md](RUNBOOK.md#zero-downtime-deploys-velo-server-only).

---

## Commands

Standard pnpm scripts (`dev`, `build`, `start`, `test`, `format`) are in `package.json`. Non-default:

- `pnpm lint` — tenancy check then ESLint at `--max-warnings 0`
- `pnpm test:rules` — evaluates `firestore.rules` through the Firebase Rules
  test API (no deploy). Needs `FIREBASE_ADMIN_*` in the environment; skips
  without them locally, fails without them in CI.
- `pnpm ci:check` — lint + typecheck + test + test:rules + build, exactly as CI runs them
- `pnpm check:tenancy` — [scripts/check-capability-tenancy.mjs](scripts/check-capability-tenancy.mjs):
  fails when an AI Suite capability's `execute` lacks a visible tenant anchor.
  **Adding a capability means making this pass** — see
  [docs/architecture/key-architecture.md](docs/architecture/key-architecture.md).
- `pnpm check:agent-coverage` — [scripts/check-agent-coverage.mjs](scripts/check-agent-coverage.mjs)
  (part of `pnpm lint`): every `path:METHOD` under `src/app` maps to agent tool(s)
  or a written exclusion in `scripts/agent-coverage.json`. **Adding a route means
  making this pass**. `FROZEN` (`scripts/agent-coverage-frozen.json`, routes with
  no tool yet) only shrinks; PR CI fails an added key.
- `pnpm doctor` — env-var shape check (`--live` also probes Firebase)
- `firebase deploy --only firestore:rules,firestore:indexes` — **run after any
  collection or index change.** Deploying rules alone silently skips indexes, and
  the missing composite surfaces at runtime as `FAILED_PRECONDITION`.

`src/config/landing.ts` exports `CUSTOM_BRAND`; the root landing page reads every
string from it. Edit it before any buyer deploy.

---

Stack facts the code doesn't make obvious: QStash runs all scheduled work; Paystack handles ZAR Client Billing (Stripe otherwise); voice is Vapi; the OpenRouter default model is `anthropic/claude-haiku-4-5`.

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
- **[Audit events](docs/architecture/audit-events.md)** — the append-only
  `auditEvents` stream: `recordAuditEvent()`, actor types, what is redacted, who reads it.
- **[Project structure](docs/architecture/project-structure.md)** — the annotated
  `src/` tree.

**Page width:** don't invent a new dashboard page width — the rule is in
[docs/architecture/key-architecture.md](docs/architecture/key-architecture.md).

---

## Features

Feature specs: **[docs/features/README.md](docs/features/README.md)**. Locked scopes
for in-flight work live in the `*_V1_PLAN.md` files at the repo root.

---

## Setup & operations

- **[docs/environment.md](docs/environment.md)** — every environment variable, what
  breaks without it, and the optional in-app guided-setup form.
- **[SETUP.md](SETUP.md)** — the buyer-facing setup walkthrough (the supported path).
- **[docs/onboarding-buyer.md](docs/onboarding-buyer.md)** — the Claude-driven
  version of that walkthrough, plus the troubleshooting catalog.
- **[RUNBOOK.md](RUNBOOK.md)** — operating the deployed app.
