# Handoff — 2026-09-04 06:15 SAST

**Project:** CrestaHQ (`Heinvv10/CrestaHQ`, private) — fork of the LeadStack Agency CRM template
**Branch:** `main` — clean, synced with origin
**Session goal:** Continue from the 2026-09-03 handoff: build Phase 1.2 (Meta WhatsApp Cloud API), then establish a real PR/review/merge/deploy workflow for this repo.

Supersedes `.claude/handoffs/2026-09-03-2129.md`. That handoff's facts still hold; this one adds the WhatsApp provider seam and the workflow.

## Status

Two things landed. **The WhatsApp provider seam is complete end to end** — connect, send, receive, template submit, approval poll, all rail-aware across Twilio / Meta Cloud / a stubbed bridge. And **this repo now has a workflow**: CI, PRs, blind review, a self-hosted runner. It had none of that 12 hours ago; every commit went straight to `main`.

Test suite 233 → 395. Three PRs merged (#2, #4, #7), each with green CI and a blind review that found real defects.

**Nothing is deployed. Nothing has touched a real WABA.** Every green check in the WhatsApp work is against mocks.

## What got done this session

### Phase 1.2 — WhatsApp provider seam (PRs #4, plus 9 pre-workflow commits on main)

Grilled four decisions before writing code (see `docs/WHATSAPP_PROVIDER_PLAN.md`), because 1.2 turned out NOT to be the port the parity plan implied: `ndzinga-lms` is Prisma/Postgres and tenant-scoped, CrestaHQ is Firestore and sub-account-scoped, so the send path and webhook are rewrites. Only `send-mode.ts` and the Graph template calls ported.

- `src/lib/comms/whatsapp/send-mode.ts` — the pure free-form-vs-template rule. **This is the piece worth ~$87/mo** (PARITY_PLAN 0.3): free-form wins whenever legal; a template is only ever the fallback for a closed window.
- `provider.ts` — 3-arm contract; providers declare `supportsTemplates` / `enforcesWindow` so adding the bridge later cannot silently drop the out-of-window guard.
- `cloud-client.ts`, `cloud-credentials.ts`, `cloud-payload.ts`, `cloud-templates.ts`, `send-dispatch.ts`, `template-dispatch.ts`, `template-registrations.ts`, `readiness.ts`, `resolve-provider.ts`
- `POST/GET /api/webhooks/whatsapp-cloud` (in middleware PUBLIC_PATHS)
- `POST/DELETE /api/sub-accounts/[id]/whatsapp-cloud-connection`
- Submit + approval-poll routes made rail-aware.

### The workflow (PRs #2, #7)

- `.github/workflows/ci.yml` — 2 jobs, everything blocking, ~2 min. `.github/pull_request_template.md`.
- **Self-hosted runner registered**: `velo-crestahq-u`, unix user `gha-crestahq`, unit `actions.runner.Heinvv10-CrestaHQ.velo-crestahq-u.service`. 5th runner on this box.
- `gitleaks` 8.24.3 installed to `/usr/local/bin` + `.gitleaks.toml`.
- Lint at `--max-warnings 0`; `eslint.config.mjs` now honours the `_` prefix.
- `scripts/deploy-velo.sh` now derives Node from `.nvmrc` (was pinned to a version nothing else tested against).
- `CLAUDE.md` gained "Development workflow" + "Working in a shared checkout".

## What's next

1. **Live WABA test — the single highest-value next action.** Everything in the seam is mock-verified. Acceptance criteria are in `docs/WHATSAPP_PROVIDER_PLAN.md`: inbound round-trip to AI reply, in-window free-form, out-of-window template fallback, then flip `whatsappProvider` back to `twilio` and confirm nothing changed. Needs `META_APP_ID`/`META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN` and a test WABA.
2. **No settings UI for the Cloud connection.** `/api/sub-accounts/[id]/whatsapp-cloud-connection` exists but nothing calls it — creds must be POSTed by hand. Mirror `sub-account-stripe-section.tsx`.
3. Phase 1.1 `PaystackBillingProvider` — still blocked on the Paystack account. Same mock-green trap as above, with real money on the other side.
4. Phase 1.3 recurring invoicing — grill before starting.

Hein's, unchanged from the last handoff: `docs/REVIEW_GATING_FIX.md` Parts A+B (~$63/mo, on GHL, no code), then the GBP API v4 quota request (only after Part A), Agency Pro trial decision (~2026-09-10), Paystack account.

## Open questions / blockers

- **Live WABA** gates any real verification of Phase 1.2.
- **Paystack account** gates 1.1. **Google BPA v4** gates all of Phase 3.
- Firestore has 4 sub-accounts, GHL has 5 (missing: Appliances Repairs JHB). Close before Phase 2.
- Meta's published ZA rate card still unverified against the measured $0.039795 / $0.007979.

## Context the next session needs

**Blind review earned its keep three times — CI caught none of these:**
1. A Twilio-only readiness gate made the Cloud rail unreachable (503 before reaching the dispatcher).
2. Four of five WhatsApp send paths bypassed the seam entirely; switching to Cloud would have silently broken AI auto-reply, review requests and workflow template steps — silently, because the AI orchestrator swallows send errors.
3. Switching `whatsappProvider` mid-approval stranded a template in `pending` forever — submit accepts only draft/rejected/failed and delete refuses pending, so only a manual Firestore edit recovered it.

**The near-miss no gate caught.** A `git add -A` swept a concurrent session's 490-line snapshot change into PR #3. CI was green, the blind review was genuine — but aimed at WhatsApp templates, so it never examined the snapshot work. Visible only in `git log`, read by chance. PR #3 was closed, my commits cherry-picked into a clean worktree as PR #4, and the other session (`crestahq-c9`) opened #5 and #6 for their own work. Rules now in CLAUDE.md.

**Non-obvious facts:**
- `gh pr create` and `gh pr merge` FAIL here with a GraphQL permissions error. Use REST: `env -u GITHUB_TOKEN -u GH_TOKEN gh api -X POST repos/Heinvv10/CrestaHQ/pulls --input f.json`. Prefix all `gh` calls with `env -u GITHUB_TOKEN -u GH_TOKEN`.
- Hosted-runner billing is paused account-wide; every repo here uses a self-hosted runner. One runner = jobs serialise (~2.5 min wall clock, not 1m53s).
- Node: `.nvmrc` is 22.23.1; system node is v20. Use `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`.
- Firestore `FieldValue.serverTimestamp()` IS valid inside a nested map under a dotted update path — verified against `@google-cloud/firestore@7.11.6` source. Only array elements are rejected.
- Template approval belongs to a **WABA**. Flat `contentSid`/`status` are simultaneously Twilio's registration AND what the UI renders, so a cloud write freezes the legacy values into `registrations.twilio` before mirroring. Do not "simplify" this away.
- `template-registrations.ts` and `provider.ts` deliberately carry NO `server-only` import — a client component imports them.

**Method that keeps working:** mutation testing. ~25 guards this session were each broken in the source and confirmed to fail a test. It does not reveal untested code, though — only a fresh reader does.

### DO NOT RESURRECT

- **`--max-warnings <N>` as a lint cap.** Reviewed and rejected: a cap is a one-way ratchet — fixing a warning silently grows slack for the next. 47 of the original 51 warnings were already `_`-prefixed and ESLint simply wasn't configured to honour them. The answer was zero, not a tighter number.
- **`gitleaks/gitleaks-action`.** It downloads via `/tmp/gitleaks.tmp`, which on this box is owned by `gha-apexgeo` under a sticky `/tmp` and is actively used by their CI. Another runner user cannot delete it. Use the host-installed binary.
- **`git add -A` / `git add .`** in this repo. See above.
- **Twilio as the self-hosted WhatsApp rail** — ~$50/mo MORE than GHL. Only Meta Cloud direct wins.
- **Places API for review monitoring** — caps at 5 reviews, no reply field.

## Git state

- **Uncommitted:** clean
- **Unpushed:** none
- **Stashes:** none
- **Worktrees:** `/home/hein/Workspace/CrestaHQ` (main) and `/home/hein/Workspace/CrestaHQ-wt-snapshots` (another session's `feat/snapshot-custom-fields-persona`) — leave that one alone.
- **Open PRs not mine:** #5 (`docs/ghl-workflow-reconstruction`), #6 (`feat/snapshot-custom-fields-persona`) — both `crestahq-c9`'s.

## Session teardown

No background processes belonging to THIS project. Still running, other projects, left alone: a `gh run watch` for FF_Next.js, two `next build` (FF_Next.js runner, IsaFlow worktree), one long-lived walkthrough `next build && next start`.

## Where to resume

Read `docs/WHATSAPP_PROVIDER_PLAN.md` (acceptance criteria at the bottom), then either wire the Cloud connection settings UI, or run the live WABA test if credentials exist.

Verify anything before trusting it:
`export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && corepack pnpm ci:check`
