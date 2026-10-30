# Agent monitors — AI Agents → Monitors (upstream 1.0.54 port, D1)

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md).*

> **NOT runtime-verified.** Merged dark: `agentsEnabledByAgency` defaults off and
> no tenant has walked the stale deals monitor yet. The live walk is #1000 with a
> test deal and a short threshold; until then the tests below are the only
> evidence.

Background agents that watch the CRM every hour and only ever ADD internal items:
a Task, a team push, an activity row and a dedupe stamp. They never message a
customer and never move or edit a deal. Both live on the **Monitors** tab of AI
Agents ([monitors/page.tsx](../../src/app/(dashboard)/sa/[subAccountId]/ai-agents/monitors/page.tsx)).

- **Gates (Decision 1 of the 1.0.54 plan).** Each monitor keeps its own gate:
  - Inbox Follow-up Watchdog — `labsEnabledByAgency` + `aiSuiteEnabledByAgency`,
    unchanged from Labs ([labs-watchdog.md](labs-watchdog.md)). It moved from the
    Labs page to this tab; the sweep, the route and the gates are as before.
  - Stale deals — `agentsEnabledByAgency` (opt-in, default off,
    `assistantMayEnable: false`). The sweep skips with `agents_gate_off`; the
    config route 403s both GET and PATCH while the gate is off. No AI key is
    needed: the AI only words the note (see below).
  - The tab shows when either gate is on; a locked monitor renders a Lock card.
- **Shared step.** The existing hourly `leadstack-agents-watchdog` QStash schedule
  (no new schedule) → `POST /api/agents/watchdog/step` runs the watchdog sweep
  ([agents-watchdog-service.ts](../../src/lib/server/agents-watchdog-service.ts),
  which skips stale-deals docs) FIRST, then
  [agents-stale-deals-service.ts](../../src/lib/server/agents-stale-deals-service.ts)::`runStaleDealsSweep()`
  inside a 40 s budget shared by every stale-deals agent (least recently run
  first; whatever is left goes first next hour). A stale-deals failure is logged
  and never fails the watchdog's response. A stale-deals doc runs only when its
  id is `{subAccountId}_stale-deals` for the `subAccountId` it carries.
- **Stale deals (`type: "stale-deals"`).** Rules decide, the model only words
  the note.
  - Query `deals(subAccountId, stageChangedAt <= now − thresholdDays)` in
    (`stageChangedAt`, doc id) order, up to 5 pages of 200 per run, resuming from
    the agent's persisted `scanCursor`; reaching the end of the window resets it,
    so the next run starts from the oldest. Deals it can never flag therefore
    can't pin the window. Composite index `deals(subAccountId, stageChangedAt ASC)`.
  - In memory: drop `mode == "test"` (a deal with no `mode` — form and quote
    deals — is live, so `mode` is not a query filter); pipelines outside
    `pipelineIds`; `excludeStageKeys` (`pipelineId:stageId`); any stage that is
    terminal on the deal's OWN pipeline (`dealStage` over `readPipelines`, so a
    custom pipeline's Won/Lost count) or cannot be resolved; deals already
    alerted this stage visit (`staleAlertedAt >= stageChangedAt`); deals held
    by a recent-work stamp.
  - Per deal (≤60 checked, ≤20 flagged per run; the cursor stays before what
    a cap or the budget left): the contact counts only if it belongs to the same
    sub-account. Recent work = an open task on the deal, a conversation message
    either way inside the window, or a contact activity with `meta.dealId` = the
    deal inside the window (queried by deal id; index `activities(meta.dealId,
    createdAt DESC)`). Recent work stamps `staleCheckedAt` and `staleWorkAt` (the
    work's time; null for an open task). The deal is skipped until
    `staleWorkAt + thresholdDays` — computed with the CURRENT threshold, so
    lowering it releases holds at once — or, for an open task, a day after the check.
  - Note, then claim, then act. The note is written first, so only the Task
    write sits after the claim. The visit is claimed in a transaction that re-reads the
    deal and stamps `staleAlertedAt` only if `stageChangedAt` is unchanged and
    the visit is unclaimed — so two overlapping sweeps raise one alert, and a
    deal that moved stage mid-run is left armed. If the Task write fails the
    claim is released the same way, so a later pass retries; a Task that did
    land is an open task, which the retry's recent-work check finds.
  - The note: one `callAi` per flagged deal (`maxTokens: 80`) only when an AI
    key is configured and the daily budget has room; otherwise, or on failure,
    a templated note. The deal title, contact name and stage go in as one-line
    labelled data with quotes and control characters stripped, and the system
    prompt says not to follow instructions in them. A note containing a link,
    domain, phone number or email address is replaced by the template.
  - Actions: a Task with `dealId` (`createdByUid: "ai-monitor"`), assigned to
    `deal.assignedToUid` while that member is active, on the deal's territory
    (a legacy untagged deal → `null`, admins only — never Global); a push (tag
    `stale-deal-{dealId}`, same territory, at most 5 per run, suppressed in quiet
    hours); an activity row on the contact (same-sub-account contacts only).
  - Re-arm: every stage writer stamps `stageChangedAt` with the server time
    (`deals-service`, `v1/deals/[id]`, bulk import, workflow `move_stage` through
    the service), which is later than the stamp.
- **Errors.** A deal whose check or action throws is counted in the run doc
  (`errors`, with the first message in `error`) and the scan moves on. When
  every checked deal errored (e.g. a missing index) the run is `failed`, never
  an "all clear".
- **Ceiling.** The watchdog's `where("enabled","==",true)` query reads at most
  500 agent docs of any type (stale-deals docs included); past that some
  watchdogs would silently never run. Stale deals reads at most 200 of its own.
- **Config.** `GET/PATCH /api/sub-accounts/[id]/agents/stale-deals` (admin;
  threshold 3–60 days; pipeline and stage filters validated against the live
  pipelines) →
  [stale-deals-section.tsx](../../src/components/ai-agents/monitors/stale-deals-section.tsx).
  Storage: `customAgents/{subAccountId}_stale-deals` + `runs/` (see
  [firestore-collections.md](../architecture/firestore-collections.md)).
- **Assistant.** No tools yet: `stale_deals_status` /
  `configure_stale_deals_monitor` are unit T3.
- **Deploy step.** `firebase deploy --only firestore:rules,firestore:indexes` —
  without the `deals(subAccountId, stageChangedAt ASC)` and
  `activities(meta.dealId, createdAt DESC)` composites the sweep's queries throw
  FAILED_PRECONDITION and the run is recorded as failed. No rules
  change: deals are already server-write-only.
- **Tests.** [agents-stale-deals-service.test.ts](../../src/lib/server/agents-stale-deals-service.test.ts)
  (per deal) and [.scan.test.ts](../../src/lib/server/agents-stale-deals-service.scan.test.ts)
  (cursor, hold, caps, budget, watchdog gates) — real sweep, pipelines, task
  writer and deal-service stage move over the in-memory Firestore; the step
  route's order test; and the config route's
  [route.test.ts](../../src/app/api/sub-accounts/[id]/agents/stale-deals/route.test.ts).
  Monitors page: `e2e/specs/agent-monitors.spec.ts`.
