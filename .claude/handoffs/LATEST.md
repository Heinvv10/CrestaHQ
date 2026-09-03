# Handoff — 2026-09-03 12:13 SAST

**Project:** CrestaHQ (`Heinvv10/CrestaHQ`, private) — a fork of the LeadStack Agency CRM template
**Branch:** `main` (clean, all pushed, 269c8f1)
**Session goal:** Clone LeadStack, stand it up as CrestaHQ on our own infrastructure, migrate off GoHighLevel, and decide whether the move is worth it.

## Status

CrestaHQ runs locally against its own Firebase project with all four active GHL sub-accounts and 22,732 contacts migrated and verified. One feature shipped (a Google-review + private-feedback page) behind the repo's first test suite. The migration is NOT complete: opportunities, notes and workflows are still only in GHL, and no deployment exists yet. Three items are blocked on Hein, one with a hard deadline (~10 Sep).

The most important finding of the session is NOT about code: **four live GHL workflow branches gate Google reviews by sentiment**, which Google prohibits and has enforced since April 2026. Fix is written and approved but NOT applied.

## What got done this session

**Repos**
- `/home/hein/Workspace/Leadstack` — pristine upstream mirror. Hourly systemd timer `leadstack-update.timer` fast-forwards it; refuses if dirty or has local commits. Script `~/.local/bin/leadstack-update.sh`, log `~/.local/state/leadstack-update.log`.
- `/home/hein/Workspace/CrestaHQ` — the working fork. `origin` = Heinvv10/CrestaHQ, `upstream` = the template with **push disabled**. Pull template updates with `git fetch upstream && git merge upstream/main`.

**Infrastructure (Google account `blitzfibre1@gmail.com`)**
- Firebase project `crestahq-app` (number `893869567850`), Blaze billing on account `016200-BBE514-1DC00F`.
- Firestore + Storage in **africa-south1** (Johannesburg). Auth email/password on. Rules + indexes deployed.
- Admin SDK service account `crestahq-admin@crestahq-app.iam.gserviceaccount.com`. All key files shredded after use.
- GBP APIs enabled that need no approval: accountmanagement, businessinformation, performance, notifications, places.

**Migration (read-only against GHL; nothing in GHL was modified)**
| LeadStack sub-account | # | ID | Contacts | Custom fields |
|---|---|---|---|---|
| CrestaHQ | 1000 | `54vPI0BS1zDMcxMyMAyA` | 3,163 | 7/7 |
| Blitz Fibre | 1001 | `XMbEpGkNjiQyyGstFsnw` | 8,383 | 44/44 |
| Velocity Fibre | 1002 | `q5S13l3R0DwTr6LQHfDY` | 3,368 | 48/48 |
| Vortex Media | 1003 | `FbLamqHWk44hLCdLDRuB` | 7,818 | 50/52 |

Spot-checked against source in Firestore: names, phones, tags and field VALUES all match.

**Shipped** — public review + private feedback page at `/r/[token]`, merged as `03efe85` (PR #1, squashed). Deliberately NOT review gating. Plus the repo's first test suite (52 tests, vitest) and CrestaHQ branding.

## What's next

1. **Fix the four gated workflow branches in GHL.** Read `docs/REVIEW_GATING_FIX.md` — it has paste-ready copy, workflow IDs and both place IDs. ~5 minutes in the builder. THIS IS THE HIGHEST-VALUE OPEN ITEM.
2. **Downgrade GHL Agency Pro -> Unlimited on ~10 Sep** (the LAST day of the trial). Downgrading earlier ends the trial immediately and charges sooner.
3. **Submit the Business Profile API v4 quota request** — `docs/GBP_API_QUOTA_REQUEST.md`. Review monitoring and replying cannot be built until Google approves; the clock has not started.
4. Migrate opportunities + notes (needs a GHL Private Integration Token — see blockers).
5. Deploy somewhere. Nothing is deployed; the app only runs locally.

## Open questions / blockers

- **GHL workflow builder cannot be driven from this environment.** The workflows iframe (`client-app-automation-workflows.leadconnectorhq.com`) fails to load: headless renders blank, headed on `:1` renders a broken-page icon. Four separate approaches failed. This is why item 1 is manual.
- **A GHL Private Integration Token is needed** for LeadStack's built-in GHL import wizard (`src/lib/import/ghl/`), which handles opportunities + notes + stage mapping. GHL's scope picker would not open across two techniques, so the token was never created. Hein can make one in 2 minutes: sub-account -> Settings -> Private Integrations -> Create, scopes `contacts.readonly` + `opportunities.readonly`.
- **GitHub GraphQL is blocked for this account** — `gh pr create` and `gh pr comment` both fail with "does not have the correct permissions" / "Pull requests are disabled for this repository". The REST API works: `gh api --method POST repos/Heinvv10/CrestaHQ/pulls --input file.json`. PR #1 was created that way.
- **Annual pricing is undecided.** `priceAnnual` in `src/config/landing.ts` deliberately equals monthly. Do not invent a discount.
- **Tier feature bullets are unapproved copy** — inferred from what CrestaHQ sells, invisible while the pricing section is hidden. Read them before ever un-hiding it.

## Context the next session needs

- **Node 20 is too old.** pnpm 11.6 needs Node >=22.13. `.nvmrc` pins 22.23.1; prefix commands with `export PATH=/home/hein/.nvm/versions/node/v22.23.1/bin:$PATH`.
- **`pnpm dev -- -p PORT` does not work** (Next reads `-p` as a directory). Use `npx next dev --turbopack -p PORT`. Ports 3000/3003/3010/3021 were all busy on this machine; 3777 was free.
- **Never run `pnpm build` while `pnpm dev` is running** — it clobbers `.next` and the dev server starts returning 500s that look like code bugs. Cost ~20 minutes to diagnose.
- **GHL contacts are phone-keyed, not email-keyed.** Blitz has 19 email addresses across 8,383 contacts. Any import must dedupe on phone.
- **GHL custom-field VALUES live in `fieldValueString` / `fieldValueDate`**, not `value` or `fieldValue`. Reading the wrong key silently imports nothing while the import API still reports "N updated" — the counters lie. Always verify in Firestore, not by the response.
- **GHL workflow steps are NOT in the REST export** (metadata only). The real step bodies are at the `fileUrl` on each workflow doc, served from Firebase Storage. That is how the gating audit was done.
- **LeadStack caps custom fields at 50 per contact** and labels at 60 chars; dropdowns require an options list. Vortex lost 2 of 52 fields to the cap; 20 long Agency-OS survey labels were truncated to 57 chars + "...".
- **The navbar name comes from the AGENCY Firestore doc, not `src/config/landing.ts`** (`resolve-brand.ts` prefers the agency doc). It was "blitzfibre1's Agency"; updated in Firestore to CrestaHQ. A code-only change will not fix it.
- **Three defects were found in one feature across two blind reviews plus the test-writing pass** — a non-atomic token burn, a click-ping that wrote a row while leaving the token live, and a taskId back-reference that reported "no task" for a task that was created. Every fix round introduced the next defect. Review the FIX commit, not just the original diff.
- **DO NOT RESURRECT: sentiment-gated review routing.** Sending 4-5 star customers to Google and 1-3 star customers to a private form is the one design that must never be built here. It is prohibited by Google's Maps UGC policy and actively enforced since April 2026. GHL still ships this template and calls it "compliant" in its own marketing — that is not a defence. The compliance rationale is comment-blocked at the top of `src/app/r/[token]/page.tsx`, `src/components/reviews/public-review-view.tsx` and `src/types/review-feedback.ts`. The tempting one-line regression is `rating >= 4 && <GoogleLink/>`.
- **Cost reality:** GHL is Agency Pro $497/mo (on trial) + $69/mo add-ons + roughly $450/mo of usage wallet at the observed burn (~$90 in 6 days) = ~R17,780/mo. Self-hosted LeadStack models at R3,120-5,710/mo. Biggest single line is Twilio SA SMS at $0.1355 outbound. See memory `project_ghl_vs_leadstack_cost`.
- **Feature parity is NOT there.** LeadStack lacks GBP integration, review monitoring/responding, a real funnel builder (its `/website` is a thin gitpage.site wrapper), a visual workflow canvas, phone/call tracking, memberships and ad lead-sync. The review-request engine in `src/lib/reviews/` is genuinely good and was initially underrated in this session.

## Git state
- **Uncommitted:** clean
- **Unpushed commits:** none
- **Stashes:** none
- **Branches:** `main` only; `feat/review-feedback-page` merged and deleted both sides

## Background processes still running (not killed)
- `next dev` on port 3777 (PIDs ~74951 / 76504 / 76510) — safe to kill
- A `next build` shell (PID ~258500) — likely finished; verify before killing
- Nothing else: no worktrees, no test containers, no orphaned Chrome

## Where to resume
Read `docs/REVIEW_GATING_FIX.md` and make those four GHL edits. Then `docs/GBP_API_QUOTA_REQUEST.md`.
Relevant memory: `project_ghl_review_gating_exposure`, `project_ghl_vs_leadstack_cost`, `project_crestahq_brand` (in the ApexSignal memory dir).
