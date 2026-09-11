# Handoff — 2026-09-11 (GBP reviews & reputation, 4 stacked PRs)

**Project:** CrestaHQ (`Heinvv10/CrestaHQ`). Supersedes `.claude/handoffs/2026-09-04-1653.md` (already archived; identical to the previous LATEST).
**Goal:** `/home/hein/Downloads/CrestaHQ-GBP-REVIEWS-GOAL-v2.md` (overrides v1 `…-AUTONOMOUS-GOAL.md`).

## State (proof, not narrative)
| PR | Branch | Base | Status |
|---|---|---|---|
| #77 | `feat/gbp-1-provider` | `main` (e5aa873) | open · CI green (lint/tsc/test/build, Playwright, secret scan) · 7 blind review rounds, last APPROVE |
| #78 | `feat/gbp-2-sync` | PR 1 | open (head f680eea) · local gate green (1788 tests, Playwright 12/1 skipped, gitleaks clean) · 6 blind review rounds, last APPROVE · CI green (lint/tsc/test/build, Playwright, secret scan) |
| #79 | `feat/gbp-3-public-feed` | PR 2 | open (head 9084e81) · local gate green (1951 tests, Playwright 14/1 skipped, gitleaks clean) · 4 blind review rounds, last APPROVE · CI green (lint/tsc/test/build, Playwright, secret scan) |
| PR 4 | `feat/gbp-4-inbox-reply` | PR 3 | opened with this commit (head after 730f09d) · local gate green (2089 tests, Playwright 16/1 skipped, gitleaks clean) · review team + 3 fix-round reviews, last APPROVE · CI pending at handoff |

Worktrees: `/home/hein/Workspace/CrestaHQ-wt-gbp-{reviews,2,3,4}`. Orchestration record: `/home/hein/Workspace/.gbp-orch/` (backup
`~/.local/share/gbp-orch-backup/`). Push / `gh` need `env -u GITHUB_TOKEN` (the session token is a different account).

## Proof
- Browser proof (fixture data only): `docs/features/gbp-reviews/proof/` — PR 1 connect/pick/revoke/reconnect GIF + 7 screenshots; PR 3 six flow GIFs + screenshots; PR 4 reply + review-link GIFs + 6 screenshots.
- Review logs, mutation tables and gate logs: `/home/hein/Workspace/.gbp-orch/` (rev1–4-results.md, pr1–4-mutations.md); also embedded in each PR body.

## Owner approvals outstanding (none executed)
- Sign off the v2 §5 deviation (fake provider allowed in the production BUILD for CI only; production refused by the inlined-URL fence + both deploy checks).
- Before the first deploy after merge: run the `sudo -u velo` check block in `docs/features/gbp-reviews.md`.
- Set `TRUST_CF_CONNECTING_IP=1` in `/home/velo/crestahq-config/.env.production` BEFORE the next deploy (deploy-velo.sh refuses without it).
- Deploy registers `leadstack-gbp-retention` (daily, Firestore-only); `GBP_SYNC_SCHEDULE_ENABLED=1` enables the 6-hourly Google sync.
- The `/r/[token]` fix (PR 4) makes the Google review button appear on feedback links customers already received — needs explicit OK before deploy.
- `gcloud services list --available --project crestahq-app | grep mybusiness.googleapis.com` (v4 approval, case 4-6894000042302).
- Live proof with Hein present; Velocity website cutover.

## Four states
fixtures-tested ✅ / real-Google-tested ❌ / deployed ❌ / Velocity-connected ❌
