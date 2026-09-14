# GHL parity program — numbered subprojects

**Date:** 2026-09-05 · **Owner:** Hein · **Orchestrator:** Fable (planning), delegated tiers for build
Supersedes the *sequencing* in [PARITY_PLAN.md](PARITY_PLAN.md) (its findings and cost analysis still stand).

## Decision summary (grilled 2026-09-05)

**Verdict:** Proceed with constraints.

**Decided**
1. **Scope = the full GoHighLevel sub-account + agency feature set.** ~~minus the WhatsApp channel (separate bridge programme)~~ — struck 2026-09-11: the numbers are moving onto LeadStack's Cloud rail, so GHL's WhatsApp settings surface is in scope as SP15. Everything GHL has that LeadStack does not already have is in.
2. **Every feature must be a step up, never worse than GHL** — UI, UX and end-to-end behaviour including OAuth.
3. **Done means shown working in a browser, end to end, by the orchestrator's own tabs**, backed by a Playwright spec that fails when the feature breaks. A claim is not done.
4. **Proving tenant = CrestaHQ's own sub-account (#1000).** Contacts for all four sub-accounts were already imported 2026-09-03; CrestaHQ's workflows and channels get rebuilt on it first. **Blitz, Velocity, Vortex stay on GHL** until the final cutover subproject.
5. **GBP API v4 access applied for 2026-09-05** (case 4-6894000042302, ~7–10 business days). Reputation is built against a fixture adapter; the live v4 adapter slots in on approval.
6. **Subprojects are numbered so each can be planned and executed in its own session, several in parallel.** Each session starts by reading this file and its own section, then runs `grill-me` on its own scope before building.

**Proven assumptions** — source counts are re-checkable and are stated as of commit `8f516ba`; figures about GHL accounts and about migrated production data are asserted from live observation and cannot be verified from this repo.
- Heavy GHL use is Contacts, Conversations, Automation, Reputation, Opportunities, email; 9 published review workflows carry the business (ApexSignal `ghl-review-workflow-parity.md`).
- Contacts/custom fields/tags already migrated and verified (22,732 contacts).
- Review-gating fixed in all 4 live GHL branches on 2026-09-05, so the Google application is truthful.
- No E2E harness exists in the repo (52 Vitest files, zero Playwright).

**Remaining risks**
- Google may reject or sit on v4 for >60 days → reputation stays fixture-only (kill criterion in PARITY_PLAN.md).
- Sites/Funnels is the largest single build and the least used by the four businesses today.
- GHL's workflow builder cannot export its graph; the 25 published workflows are rebuilt from recovered message copy (`docs/WORKFLOW_RECONSTRUCTION.md`, branch `docs/ghl-workflow-reconstruction`).
- Meta App Review gates FB/IG inbox + posting; Meta Tech-Provider status gates WhatsApp embedded signup (out of scope here, but conversations parity leans on it).

**Execution guardrails (apply to every subproject)**
- Branch per subproject (`feat/sp<N>-<slug>`), worktree, never `main`. Blind `/review` before merge; `review-team` for 500+ line diffs.
- CI gate unchanged: `pnpm ci:check` + gitleaks; Playwright job added by SP0 and required from then on.
- Level-3 auto-merge applies only inside the boundary (greenfield, no live client data, tests that fail when wrong). Anything touching Blitz/Velocity/Vortex data or outbound customer comms keeps a human gate.
- Delegation: planning on Fable; implementation `coder` (sonnet) / `coder-hard` (opus); review `reviewer`; lookups `lookup`.
- Browser proof: the orchestrating session opens GHL and crm.crestahq.com side by side and walks the same screens. Screenshots of both go in the PR.

---

## The parity ledger

Each subproject maintains a ledger table in its own doc (`docs/parity/sp<N>.md`):

| GHL screen / behaviour | Observed in GHL (date, screenshot) | CrestaHQ today | Gap | Spec that proves it | Status |

A row is **done** only when the last two columns are filled and the spec is green in CI.

---

## Subprojects

Dependencies are noted; anything not listed as a dependency can run in parallel.

### SP0 — E2E harness + CrestaHQ tenant goes live
**Goal:** Playwright suite in CI on the self-hosted runner, running against crm.crestahq.com with two tenants: CrestaHQ (#1000, real data, real OAuth) and a seeded fixture tenant (#1004 "E2E Fixtures") for destructive/repeatable cases. Service-account login for the suite; no human credential in the repo.
**Includes:** rebuild CrestaHQ's one GHL workflow (Audit clicked → Contacted + notify); connect its Google, Meta and Paystack (test mode) OAuth; first specs = login, sub-account switch, contact create, workflow enrol, form submit → contact.
**Done when:** CI runs the suite on every PR; the four first specs are green; CrestaHQ's own inbox and workflow are running on crm.crestahq.com and not on GHL.
**Depends on:** nothing. **Everything else depends on this.**
**Tier:** coder-hard. **Size:** ~5 days.

**Status (2026-09-05):** split into three PRs — see [docs/parity/sp0.md](parity/sp0.md).
- **SP0-A — the harness — MERGED (PR #27).** Playwright runs on every PR and
  blocks merge. Five specs green, each proven to fail under a scripted mutation
  of production code. **Wave 1 (SP1, SP2, SP3, SP5-fixture, SP13) is unblocked
  and may start now** — those subprojects depend on the harness, not on the
  tenant being live.
- **SP0-B — Google OAuth + per-tenant Paystack — not started.** Both subsystems
  are absent from the codebase; Hein chose to build them inside SP0 rather than
  defer them to SP5/SP9.
- **SP0-C — CrestaHQ tenant live — BLOCKED.** `crm.crestahq.com` has no
  `QSTASH_*`, so no workflow can run there at all: `scheduleNode` marks every
  run failed immediately. Also missing `META_APP_ID`/`META_APP_SECRET` (the Meta
  connect button 403s `not_configured`), `STRIPE_SECRET_KEY` and
  `PAYSTACK_SECRET_KEY`. This is a deployment gap, not a build task.

### SP1 — Contacts, Smart Lists, Opportunities, Tasks
**GHL surface:** Contacts (smart lists, bulk actions, custom fields UI, notes, tasks, company), Opportunities (multiple pipelines, stages, pipeline reporting), Tasks.
**CrestaHQ today:** contacts list/search/profile, CSV import/export, single 6-stage pipeline, tasks, Cmd+K.
**Known gaps:** saved smart lists, bulk tag/assign/delete, multiple pipelines, stage automation hooks, company objects, contact activity timeline parity, GHL-style custom-field folders.
**Depends on:** SP0.

### SP2 — Conversations / unified inbox (email, SMS, WhatsApp, FB/IG)
**GHL surface:** Conversations tab, unread/starred/all filters, assignment, internal notes, templates/snippets, scheduled messages, email threading, missed-call text-back.
**CrestaHQ today:** email + SMS from contact profile, FB/IG DM beta behind gate, missed-call route exists.
**Known gaps:** a true inbox surface with filters and assignment, snippets, scheduling, email threading, Meta App Review for FB/IG publish scopes.
**WhatsApp is in scope** (Cloud + bridge rails) — the earlier exclusion ~~WhatsApp channel (bridge programme owns it; the seam is built)~~ is struck (2026-09-13). The WhatsApp *settings* surface is SP15. Ledger: [docs/parity/sp2.md](parity/sp2.md).
**Depends on:** SP0.

### SP3 — Calendars & booking
**GHL surface:** calendar types (round-robin, collective, class, service), availability, buffers, appointment statuses, reminders, Google/Outlook sync, booking widgets.
**CrestaHQ today:** manual month grid, public booking pages with slot reservation, ICS, reminders via QStash, voice booking (unverified).
**Known gaps:** Google Calendar OAuth sync, round-robin/team calendars, appointment status lifecycle, embeddable widget parity.
**Depends on:** SP0.
**Status (2026-09-14):** **merged:**
- calendar types (#109)
- availability rules (#110)
- status lifecycle + booking triggers (#107)
- Google Calendar two-way sync (#115)
- embeddable widget (#116)
- test guard (#120)
- appointments list + filters (#119)

The QStash reminder is proven on #1000. Voice booking can't run in production (empty OpenRouter/Vapi keys); its code path was proven. **Deployed 2026-09-14 (`d0c3893`).** Ledger: [docs/parity/sp3.md](parity/sp3.md).

### SP4 — Sites: funnels, websites, forms, surveys
**GHL surface:** drag-drop funnel/page builder, templates, domains, forms and surveys with conditional logic, chat widget, QR codes.
**CrestaHQ today:** gitpage.site website wrapper (local + VSL types), AI draft/edit in `src/lib/funnels`, forms with 6 field types, no surveys, no visual builder.
**Known gaps:** everything visual; multi-step funnels; surveys; custom domains per funnel; conditional logic. **Largest build in the programme.**
**Depends on:** SP0. Consider splitting into 4a (forms/surveys), 4b (page builder), 4c (domains/publishing).

### SP5 — Reputation & Google Business Profile
**GHL surface:** Reputation overview, reviews inbox, AI review replies + drip response, sentiment, trend charts, response coverage, review widgets, GBP optimisation, listings (Yext — resold, out).
**CrestaHQ today:** review-request sender only; `/r/[token]` compliant feedback page; **no GBP code at all**.
**Plan:** `ReviewProvider` seam with a recorded-fixture adapter now; live v4 adapter on Google approval. GBP OAuth + location picker + business-info/performance insights use APIs already enabled and can go live immediately. Port `ApexGEO/src/lib/business-profile/` (OAuth, token refresh, listReviews, updateReply, 5 test files).
**Depends on:** SP0. Live half also depends on case 4-6894000042302.

### SP6 — Workflows / automations engine + rebuild of the 25 published workflows
**GHL surface:** ~50 triggers, ~100 actions, wait/if-else/goal/webhook/AI steps, enrolment history, execution logs, test mode, folders.
**CrestaHQ today:** builder with 11 triggers and 15 node types, QStash worker, wait-for-reply.
**Known gaps:** trigger/action breadth, goal events, if/else on custom values, execution log UI, folders, test mode. Then rebuild Blitz (10), Velocity (7), Vortex (7), Brightsphere (1) from `docs/WORKFLOW_RECONSTRUCTION.md` — as **drafts** on the CrestaHQ tenant until SP14.
**Depends on:** SP0, SP1 (tags/pipelines), SP2 (send actions).

### SP7 — AI Agents (Conversation AI, Voice AI, Reviews AI, Content AI) — step up
**GHL surface:** AI Agents hub, Conversation AI (auto-pilot/suggestive, booking intent), Voice AI, Reviews AI, Content AI, Ask AI; all paid add-ons in GHL.
**CrestaHQ today:** one persona across web chat, SMS, WhatsApp, inbound + outbound voice; Meta DM AI, voice booking, watchdog agent all "built, unverified".
**Plan:** runtime-verify the unverified ones first; then per-channel personas, review-reply drafting (feeds SP5), content drafting for SP8, and an agency-level "Ask AI" over CRM data. This is where "better than GHL" is cheapest to prove.
**Depends on:** SP0, SP2.

### SP8 — Marketing: email campaigns + social planner
**GHL surface:** email builder + templates, campaigns with stats, A/B, social planner across FB/IG/LinkedIn/GBP/TikTok/X, content calendar.
**CrestaHQ today:** broadcasts (fan-out, unsubscribe), social planner Meta-only single image.
**Known gaps:** visual email builder, campaign analytics, multi-network posting (LinkedIn, GBP posts, TikTok, X), media library.
**Depends on:** SP0, SP13 (media storage).

### SP9 — Payments & commerce
**GHL surface:** invoices, recurring, subscriptions, payment links, coupons, products, orders, text-to-pay, Stripe/Paystack.
**CrestaHQ today:** quotes → invoices, products, recurring invoicing (engine + UI, never run live), Payments v1 on Stripe restricted key, Paystack rail for Client Billing (unproven live), PayPal.me.
**Known gaps:** customer-facing Paystack checkout (Stripe blocks SA), payment links, coupons, text-to-pay, run recurring live once.
**Depends on:** SP0.

### SP10 — Memberships, courses, communities
**GHL surface:** courses (products, offers, lessons, quizzes), communities, client portal, certificates.
**CrestaHQ today:** Community + standalone Courses (unverified), gated.
**Known gaps:** runtime verification, offers/paywall, quizzes/assessments, client portal parity.
**Depends on:** SP0, SP9 (paid offers).

### SP11 — Reporting & dashboards
**GHL surface:** sub-account dashboard widgets, attribution, call/appointment/agent reporting, agency dashboard.
**CrestaHQ today:** per-sub-account KPIs, funnel, revenue, lead-source.
**Known gaps:** agency roll-up, attribution report, configurable widgets, review/appointment reports.
**Depends on:** SP0; better after SP1/SP3/SP5 emit the data.

### SP12 — Prospecting
**GHL surface:** Prospecting tool (business lookup, marketing audit report, lead capture into pipeline).
**CrestaHQ today:** Get Leads (Outscraper maps search + enrich + import) **parked**; ApexSignal does the real pipeline externally.
**Plan:** un-park Get Leads per its checklist; add the audit-report generator (site/SEO/GBP/reviews scorecard — reuse ApexGEO audit code); optional ApexSignal write-back. Report content sent to prospects stays human-gated.
**Depends on:** SP0.

### SP13 — Agency ops: snapshots, template library, sub-account provisioning, media storage, white-label
**GHL surface:** Sub-accounts list, Account Snapshots (share/import), Template Library, Media Storage, Reselling, Affiliate Portal, agency settings/branding, Launchpad.
**CrestaHQ today:** sub-accounts + gates + Client Billing built; **Snapshots built** (capture/apply, create-only) — extend, do not rebuild; affiliate programme built for own SaaS; media storage absent; template library absent.
**Known gaps:** media library, snapshot share links / marketplace, template library, launchpad/onboarding checklist, reselling table.
**Depends on:** SP0.

### SP15 — WhatsApp settings (profile, quality rating, message links)
**Added 2026-09-11** (was excluded; the numbers are moving off GHL onto the Cloud rail).
**GHL surface:** Settings → WhatsApp → Numbers: per sender a header (flag, number, display name, Connected, quality badge), Profile tab (photo, display name read-only, about, description, category, address, email, websites, phone preview), Message Links tab (create with prefilled text, list, copy, QR, delete), Templates tab.
**CrestaHQ today:** Settings → Messaging has a Cloud connection card (connect/disconnect, number, verified name) and a sender registry; templates at `/sa/[id]/ai-agents/whatsapp/templates`. No profile, no quality rating, no message links — none of `whatsapp_business_profile`, phone `quality_rating` or `message_qrdls` is called anywhere.
**Plan:** Graph client behind a provider seam (real + fake, fenced like GBP's) reading the token from `subAccounts/<id>/private/whatsappCloudConnection`; routes under `/api/sub-accounts/[id]/whatsapp/*`; page at `/sa/[id]/dashboard/settings/whatsapp`; hourly QStash poll of `quality_rating` that alerts the owner on a drop from GREEN. Ledger: [docs/parity/sp15.md](parity/sp15.md).
**Depends on:** SP0. Read-only probes against Velocity only; no outbound message.

### SP14 — Client cutover (Blitz, Velocity, Vortex)
**Gated on Hein. Never auto-merges.**
**Scope:** contact delta since 2026-09-03 import; activate rebuilt workflows; connect GBP for each listing (needs SP5 live adapter); WhatsApp number strategy from the bridge programme; conversation-history import if feasible; GHL downgrade/cancel timing.
**Depends on:** SP1–SP7 done on the CrestaHQ tenant, SP5 live, WhatsApp bridge decision.

---

## Suggested parallel waves

| Wave | Run together |
|---|---|
| 0 | SP0 |
| 1 | SP1, SP2, SP3, SP5 (fixture half), SP13, SP15 |
| 2 | SP4, SP6, SP7, SP9, SP12 |
| 3 | SP8, SP10, SP11 |
| 4 | SP14 |

## How a subproject session starts

1. Read this file, `CLAUDE.md`, `docs/architecture/*`, and the feature spec(s) for its area.
2. Open GHL and crm.crestahq.com in its own Chrome tabs (shared profile, already logged in) and fill the ledger's first three columns screen by screen.
3. `grill-me` on the ledger; produce `docs/parity/sp<N>.md` with the DAG, gates and review strategy.
4. Build on a worktree branch; specs first; blind review; browser proof; merge.
