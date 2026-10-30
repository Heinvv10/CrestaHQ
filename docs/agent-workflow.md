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

CI (every workflow) runs on **GitHub-hosted `ubuntu-latest`**. If jobs never start or fail instantly with a
billing/spending-limit annotation, check the account's Actions billing first.

E2E touches one shared set of fixture sub-accounts in the production Firestore
(global setup purges them wholesale), so every E2E run — PR, push, and the
production smoke — queues in the repo-wide `crestahq-e2e-fixtures` concurrency
group with `cancel-in-progress: false`. GitHub holds only one *pending* run per
group, so a third run queuing behind a running one cancels the older pending
one; a cancelled E2E check needs a re-run, not a fix.

The Go workflows (`wa-manager.yml`, `wa-agent-bridge.yml`) are on
`ubuntu-latest` too; no workflow uses the old self-hosted runner any more.

### Deploy

`bash scripts/deploy-velo.sh` — run ON velo-server, from the deploy checkout.
Gates run before the service is touched, so a failed build can never leave a
half-served app returning 500s. Production deploys are refused inside business
hours (08:00–17:00 SAST, Mon–Fri); `--force` overrides **the time window only**,
never the gates. The deploy dir is a target, not a workspace — the script
refuses to run against a dirty checkout. Deploys are zero-downtime blue/green
and `--rollback` switches back to the previous release; layout and the one-time
migration are in [RUNBOOK.md](../RUNBOOK.md#zero-downtime-deploys-velo-server-only).
