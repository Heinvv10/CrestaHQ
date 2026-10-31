# Agent workflow: branch, review, merge, deploy

Moved verbatim from `CLAUDE.md` (former lines 54-161). CLAUDE.md keeps a summary with every prohibition.

## Development workflow — branch, review, merge, deploy

**Never commit to `main`.** First action of any code task is a branch
(`feat/…`, `fix/…`, `ci/…`, `docs/…`). Everything lands through a PR.

### The gates

| Gate | Where | Blocks? |
|---|---|---|
| `pnpm lint` (tenancy check + ESLint) | CI + `deploy-velo.sh` | yes |
| `pnpm exec tsc --noEmit` | CI + deploy | yes |
| `pnpm test` | CI + deploy | yes |
| `pnpm test:rules` (Firestore rules, via the Rules test API) | CI | yes |
| `pnpm build` | CI + deploy | yes |
| gitleaks secret scan | CI | yes |
| Blind `/review` | you, before merge | yes |

`pnpm ci:check` runs the first five locally — byte-for-byte the same commands
CI runs, so a green local run means a green pipeline. Keep them identical; a
`npx` here and a `pnpm exec` there is the first millimetre of the same drift
that let FibreFlow's baselines diverge across five files.

`pnpm test:rules` needs `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`
and `FIREBASE_ADMIN_PRIVATE_KEY`. Without them the rules specs skip (a local
`ci:check` shows them all skipped), so a local skip is not a gap. CI passes the
secrets to the "Firestore rules tests" step, and with `CI` set a missing
credential fails the step instead of skipping.

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

Every CI job runs on **GitHub-hosted `ubuntu-latest`** — lint/typecheck/test/build,
secret scan, FROZEN-shrink, the Go workflows, the **E2E job in `ci.yml`** and
**`e2e-smoke.yml`**. Nothing runs on velo-server any more.

Every E2E run (PR or production smoke) seeds and purges the same fixture
sub-accounts in the production Firestore (`e2e/global-setup.ts`
`purgeFixtureData` is global), so runs must never overlap. A GitHub concurrency
group cannot do that without losing runs: it keeps only one *pending* run and
cancels the older one when a third queues. Instead the suite job sits between
two jobs that run `scripts/ci/fixture-lock.mjs` (`e2e-lock` → `E2E (Playwright)`
→ `e2e-unlock` in `ci.yml`; `smoke-lock` → smoke → `smoke-unlock` in
`e2e-smoke.yml`):

- `acquire` creates the git ref `refs/ci-locks/e2e-fixtures` (create is atomic:
  422 if it exists) and otherwise **waits**, polling once a minute and logging
  the holder run. It never cancels anything. Waiting is not FIFO, and a wait
  longer than 220 min fails that run's check. A hosted run holds the lock for
  ~55-60 min (the suite took 18 min on velo-server), so the queue drains about
  one run an hour. On a PR it gives up (failing that
  superseded commit's check) once the PR has a newer head or is closed.
- A lock whose holder run attempt the actions API shows completed (or no longer
  exists) is taken over with a fast-forward-only ref update on top of it, so two
  waiters cannot both take the same stale lock. Age never frees a live holder;
  the 150-min limit applies only to a ref commit the script did not write. The
  lock is held for the whole suite job (setup + Playwright, 120-min timeout).
- The suite job first runs `held` and fails unless this run attempt holds the
  lock. **Re-run all jobs, not "re-run failed jobs"**: the latter reruns the
  suite job but not the lock job, and the first attempt already released it.
- `release` runs in its own job under `if: always()` and, only if the recorded
  holder is this run attempt, commits a "released" marker on top of the lock
  commit it read and fast-forwards the ref to it — a compare-and-swap, so it can
  never free a lock another run took in between. The next waiter takes the
  marker at once.

Only the lock jobs get `contents: write` (the ref), plus `actions: read` (holder
check) and, for E2E, `pull-requests: read` (newer head). They check out
`scripts/ci` from the **default branch** (never the PR's copy; a one-time
bootstrap falls back to the PR's copy while main lacks the script) and run it on
node built-ins: no install, no secrets, no app
code. The suite job, which installs dependencies and runs the PR's code with the
fixture secrets, gets `contents: read`. That is not a boundary against a
same-repo PR's author, who can edit the workflow (fork PRs never run these
jobs). `E2E (Playwright)` is the required check and a skipped required check
counts as passing, so it runs under `always()` and fails itself when
`e2e-lock` did not succeed. Follow-up: the suite job still receives the fixture
secrets while running PR code (unchanged from velo-server).

**Local Playwright runs do not take the lock.** A local run against the fixture
tenants can still collide with CI; check `gh run list --status in_progress` (or
the lock ref) before starting one. The self-hosted runner `velo-crestahq-u`
(service `actions.runner.Heinvv10-CrestaHQ.velo-crestahq-u.service`) no longer
receives jobs once this is merged and can be stopped and unregistered.
To clear a wedged lock by hand: `gh api -X DELETE repos/Heinvv10/CrestaHQ/git/refs/ci-locks/e2e-fixtures`
— only when no E2E or smoke run is in its Playwright step.

Follow-up: scope `purgeFixtureData` and the fixture data per run id (as
`e2e/lib/run-id.ts` already does for specs' fixture prefixes) so runs could
overlap safely; until no spec depends on global fixture state, the lock stays.

### Deploy

`bash scripts/deploy-velo.sh` — run ON velo-server, from the deploy checkout.
Gates run before the service is touched, so a failed build can never leave a
half-served app returning 500s. Production deploys are refused inside business
hours (08:00–17:00 SAST, Mon–Fri); `--force` overrides **the time window only**,
never the gates. The deploy dir is a target, not a workspace — the script
refuses to run against a dirty checkout. Deploys are zero-downtime blue/green
and `--rollback` switches back to the previous release; layout and the one-time
migration are in [RUNBOOK.md](../RUNBOOK.md#zero-downtime-deploys-velo-server-only).
