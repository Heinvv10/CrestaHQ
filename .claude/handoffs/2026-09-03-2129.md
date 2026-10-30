# Handoff — 2026-09-03 21:29 SAST

**Project:** CrestaHQ (`Heinvv10/CrestaHQ`, private) — fork of the LeadStack Agency CRM template
**Branch:** `main` — clean tree, **8 commits unpushed**
**Session goal:** Read `docs/`, work out how to reach GoHighLevel parity, pressure-test the plan, then start executing it.

Supersedes `.claude/handoffs/2026-09-03-1213.md` (same day, earlier session — the setup + initial GHL-vs-self-hosted comparison). Not a parallel session; this one continues and *corrects* it.

## Status

The decision document this session started from was **materially wrong on its central claim**, and that was found by measuring rather than re-reading. GHL actually costs **R8,880/mo, not R17,780**, and there is **no usage markup to recapture** — August was 98.8% WhatsApp billed at approximately Meta passthrough rates. The migration case no longer rests on cost savings; it rests on control (Paystack, invoicing automation, template-send policy, not being repriced underneath us).

`docs/GHL_VS_LEADSTACK.md` now carries a corrections block, `docs/PARITY_PLAN.md` is the resequenced plan, and phase 1.4 (test coverage) is complete: **3 tests → 233**, with 61 guards verified by deleting them from production source and confirming a test fails.

Nothing is deployed. Nothing is pushed. No production behaviour changed.

## What got done this session

**Docs corrected (`b207294`, `b9a6a75`, `925ab84`, `d4fa926`, `7382dd9`)**
- `docs/GHL_VS_LEADSTACK.md` — corrections block at the top, wrong claims struck through in place
- `docs/PARITY_PLAN.md` — new; phased plan, kill criteria, open questions
- `docs/REVIEW_GATING_FIX.md` (`223b8fa`) — gained a **Part B**: paste-ready fix for the in-window review ask

**Code (`cf3a445`, `35852ff`)**
- `src/lib/billing/` — new `BillingProvider` interface + `StripeBillingProvider`, a behaviour-preserving extraction of ~17 direct Stripe calls out of Client Billing. Two blind reviewers APPROVED after checking it call-by-call against `git show HEAD:`.
- 8 new test files across comms + billing. 3 tests → 233.

**Findings that are worth money or risk regardless of the migration**
1. **~$63/mo, available on GHL today, no code.** Velocity sends its post-button review ask as a Marketing template ($0.0398) in the same minute the customer taps a button — but that tap opens a 24h service window where free-form messages cost $0.00. Blitz already does this correctly (ledger: Blitz 615 marketing / 1,378 service; Velocity 1,586 / 414). Fix is in `REVIEW_GATING_FIX.md` Part B.
2. **A guard nobody had tested** in `capture.ts::backfillContactFromCapture` — removing `!data.email?.trim()` lets an AI-hallucinated address silently overwrite a customer's verified email. Now covered.

## What's next

**Hein's, in order — none of these are blocked on me:**
1. `docs/REVIEW_GATING_FIX.md` **Part A + Part B in one builder pass.** Part A (4 gating branches) is compliance; Part B is the ~$63/mo. GHL builder gotcha: the Save button does nothing — click the canvas then **Ctrl+S**, then hard-reload to confirm.
2. **Submit the Google Business Profile API v4 quota request** (`docs/GBP_API_QUOTA_REQUEST.md`) — **only after Part A.** The application asserts we do not gate reviews; four live branches currently do. Submitting first risks a slow-to-appeal rejection that blocks all of Phase 3.
3. **Agency Pro trial decision** — billing page read "trial ends in 7 days" on 2026-09-03, so roughly **2026-09-10**.
4. **Open a Paystack account for Brightsphere Technologies** — slow external clock, nothing blocked today.

**Mine, when asked:**
5. **Phase 1.2 — port Meta Cloud API from `ndzinga-lms`** (2–3 d). The comms tests written this session exist to make this safe.
6. Phase 1.3 — recurring invoicing (absent here too; grill before starting).
7. Phase 1.1 remainder — `PaystackBillingProvider`. **Genuinely blocked** on the account: writing it blind against docs produces something that compiles, passes mocked tests, and gets its first real exercise with client money.

## Open questions / blockers

- **Paystack account** for Brightsphere Technologies — gates 1.1.
- **Google BPA v4 approval** — gates all of Phase 3. Neither CrestaHQ nor ApexGEO has ever obtained it.
- **Firestore has 4 sub-accounts; GHL has 5.** Missing locally: *Appliances Repairs JHB* ($0.03/mo). Close before Phase 2's import.
- **Unverified:** Meta's published ZA rate card was never checked against the measured $0.039795 marketing / $0.007979 utility. The "no markup" conclusion rests on the *structure* being passthrough-shaped (service messages billed at exactly $0.00, mirroring Meta's own free-service policy) plus recalled rates. Five minutes to confirm; worth doing before quoting it.
- **Node version** — `pnpm` needs 22.23.1 (`.nvmrc`) but the default shell has v20.20.1. Fix properly, or prefix: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`.

## Context the next session needs

**Decisions locked this session (also in memory `project_paystack_decisions.md`):**
- Plan switches happen **at period end**, not mid-cycle. Paystack has no proration. **Gates apply immediately; the price follows at renewal.**
- Plans priced in **ZAR** (Paystack settles ZAR/NGN/GHS/KES).
- No hosted billing portal — the dunning banner's "Update card" becomes a Paystack email-token `manage_link`.
- **Clean slate confirmed:** 0 plan docs, 0 `billingEvents`, all 4 sub-accounts comped, `STRIPE_SECRET_KEY` not even set. Client Billing has never run here, so ZAR needs no migration.

**Things already built that look like work — do not rebuild:**
- **GHL import is complete** (`src/lib/import/ghl/`) — contacts, opportunities→deals, notes, custom fields, pipeline stage mapping, chunked resumable jobs, wizard UI. Shipped in the initial template commit. Only *bulk SMS* is outstanding from that plan line.
- **Missed Call Text Back** exists (`src/lib/comms/missed-call.ts`).
- **`ApexGEO/src/lib/business-profile/`** is a near-complete GBP module: `google-gateway.ts` has `listReviews` (v4, paginated), `updateReply` (v4 PUT), localPosts, plus `repository.ts` (18KB), `service.ts` (13KB), token refresh, retention, **5 test files**. Flagged off behind `APEX_GOOGLE_BUSINESS_PROFILE_ENABLED`, awaiting the same Google approval.
- **`ndzinga-lms`** has a complete Meta Cloud API implementation: `lib/whatsapp-cloud.ts` (direct Graph send, 24h-window logic forcing template mode, APPROVED-only enforcement), `lib/whatsapp/graph-templates.ts` (`createWabaTemplate` — submits templates direct to Meta, removing the Twilio Content API dependency), `app/api/webhooks/whatsapp-cloud/route.ts` (verify_token + `X-Hub-Signature-256` via `verifyWaba`), `parseWabaStatuses`/`applyWabaStatuses`, multi-tenant `runWithTenant`, 197 lines of tests.

**A mistake made once this session — do not repeat.** There are **two independent Stripe integrations** and they are easy to confuse:

| Surface | Client | Whose money |
|---|---|---|
| **Payments v1** — sub-account charges its own customers | `src/lib/stripe/sub-account-client.ts` (sub-account's own restricted key) | the client's |
| **Client Billing** — agency charges sub-account | `getStripeServer()` | ours |

Paystack replaces the **second**. The comment at `sub-account-client.ts:148` calling itself "a one-line change" belongs to the *first* and is irrelevant to the Paystack work. `PARITY_PLAN.md` §1.1 originally cited it and had to be corrected.

**Environment / tooling gotchas discovered:**
- The **GHL workflow builder renders blank to headless Chrome** (same failure the earlier audit hit on the SaaS Configurator and Add-Ons pages). The launchpad, billing and settings pages render fine. Don't burn time retrying browser automation on the builder.
- **GHL keeps no JWT in `localStorage`** — httpOnly cookies only, so the `fileUrl` route to workflow step definitions can't be reached by injecting a token from page context.
- The MCP browser servers (`chrome-devtools`, `boss-ghost`) **share** `~/.cache/chrome-devtools-mcp/chrome-profile` and refuse to attach when one is running. An orphan headless Chrome from 2026-08-31 was holding the lock and was killed (PID 232968) to free it.
- White-label domain is **`app.crestahq.com`** (not `app.gohighlevel.com`, and no longer `app.brighttech.co.za`). Agency login is `Hein@h10.co.za` with SMS 2FA — a human must complete the sign-in.

**Method note worth keeping.** Mutation testing (delete the guard, confirm a test fails) proved the 61 guards that *had* tests were real — but it could not reveal that `capture.ts`'s entire Firestore half had no tests at all, because a guard nobody tested cannot be mutated into failing. A blind reviewer found that. Keep both; don't let a satisfying mutation table stand in for a fresh reader.

### DO NOT RESURRECT

- **"~70% of review monitoring via the Places API"** — tested live 2026-09-03 against both Blitz place IDs. Places caps at **5 reviews**, no pagination, **no reply field at all**, and `pageSize` is rejected. It yields a rating/volume trend chart and nothing else. Reputation is 100% gated on Google BPA v4.
- **Reclassifying the review-ask templates as UTILITY** — Velocity's categories are already correct (`experience_check_v2` Utility; review asks Marketing). Meta assigns the final category and will reject a promotional review ask as Utility. The saving is in *when* the message is sent, not its category.
- **Twilio as the self-hosted WhatsApp rail** — costs roughly **$50/mo MORE** than GHL (Meta rate + Twilio per-message fee) on ~10,174 msgs/mo. Only **Meta Cloud API direct** wins.
- **`archiveProduct` on `BillingProvider`** — deliberately not built. Nothing in the codebase archives a Stripe product; plan archival only deactivates prices. Adding it would be dead code.

## Git state

- **Uncommitted:** clean
- **Unpushed commits (8):** `7382dd9`, `35852ff`, `d4fa926`, `cf3a445`, `925ab84`, `223b8fa`, `b9a6a75`, `b207294`
- **Stashes:** none
- **Worktrees:** one (`/home/hein/Workspace/CrestaHQ`, main)

## Session teardown — background processes (reported, NOT killed)

Belonging to **this** project:
- `next dev --turbopack -p 3777` — PID 3103929, running ~9h from `/home/hein/Workspace/CrestaHQ`
- **9 headless Chrome processes** under `chrome-devtools-mcp/chrome-profile`, started by this session's browser automation

Belonging to **other** projects (left alone):
- `gh run watch` ×4 — FF_Next.js (PIDs 73567, 73573, 902558, 1670171/1670177)
- `next build` — `/home/velo/fibreflow-production` (PIDs 1142925/1142926)
- Docker `setup-test-db-1` — up 36h, healthy

## Where to resume

Read `docs/PARITY_PLAN.md` (the corrections block in `docs/GHL_VS_LEADSTACK.md` first if the cost figures matter).

Then either:
- **Push the 8 commits:** `git push origin main`
- **Continue with 1.2:** start from `/home/hein/Workspace/ndzinga-lms/lib/whatsapp-cloud.ts` and `lib/whatsapp/graph-templates.ts`

Verify anything before trusting it: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH" && corepack pnpm lint && corepack pnpm vitest run && corepack pnpm build`
