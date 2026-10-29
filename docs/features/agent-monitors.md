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
    `assistantMayEnable: false`) and `aiIsConfigured()`. The sweep skips with
    `agents_gate_off` / `ai_not_configured`; the config route 403s both GET and
    PATCH while the gate is off.
  - The tab shows when either gate is on; a locked monitor renders a Lock card.
- **Shared flow.** The existing hourly `leadstack-agents-watchdog` QStash schedule
  (no new schedule) → `POST /api/agents/watchdog/step` →
  [agents-watchdog-service.ts](../../src/lib/server/agents-watchdog-service.ts)::`runWatchdogSweep()`:
  one `where("enabled","==",true)` over `customAgents`, dispatched by `type`
  (absent = the watchdog). A stale-deals doc runs only when its id is
  `{subAccountId}_stale-deals` for the `subAccountId` it carries.
- **Stale deals (`type: "stale-deals"`).** Rules decide, the model only writes
  the note.
  - Query `deals(subAccountId, stageChangedAt <= now − thresholdDays)` ordered
    ascending, paged (5 × 200). Composite index `deals(subAccountId,
    stageChangedAt ASC)`.
  - In memory: drop `mode == "test"` (a deal with no `mode` — form and quote
    deals — is live, so `mode` is not a query filter); pipelines outside
    `pipelineIds`; `excludeStageKeys` (`pipelineId:stageId`); any stage that is
    terminal on the deal's OWN pipeline (`dealStage` over `readPipelines`, so a
    custom pipeline's Won/Lost count) or cannot be resolved; deals already
    alerted this stage visit (`staleAlertedAt >= stageChangedAt`).
  - Per deal (≤60 checked, ≤20 flagged per run): skip when there is an open task
    on the deal, a conversation message either way inside the window, or a
    contact activity with `meta.dealId` inside the window.
  - Claim, then act. The visit is claimed in a transaction that re-reads the
    deal and stamps `staleAlertedAt` only if `stageChangedAt` is unchanged and
    the visit is unclaimed — so two overlapping sweeps raise one alert, and a
    deal that moved stage mid-run is left armed. A claim is never released: if
    the task write then fails, that visit's alert is lost (logged).
  - One `callAi` per flagged deal (`maxTokens: 80`) writes the "suggested next
    step"; a spent daily budget or a failed call keeps the templated note. Task
    with `dealId` (`createdByUid: "ai-monitor"`), push (tag
    `stale-deal-{dealId}`, the deal's territory; a legacy untagged deal reaches
    admins only; suppressed in quiet hours), activity row.
  - Re-arm: every stage writer stamps `stageChangedAt` with the server time
    (`deals-service`, `v1/deals/[id]`, bulk import, workflow `move_stage` through
    the service), which is later than the stamp.
- **Config.** `GET/PATCH /api/sub-accounts/[id]/agents/stale-deals` (admin;
  threshold 3–60 days; pipeline and stage filters validated against the live
  pipelines) →
  [stale-deals-section.tsx](../../src/components/ai-agents/monitors/stale-deals-section.tsx).
  Storage: `customAgents/{subAccountId}_stale-deals` + `runs/` (see
  [firestore-collections.md](../architecture/firestore-collections.md)).
- **Assistant.** No tools yet: `stale_deals_status` /
  `configure_stale_deals_monitor` are unit T3.
- **Deploy step.** `firebase deploy --only firestore:rules,firestore:indexes` —
  without the `deals(subAccountId, stageChangedAt ASC)` composite the sweep's
  query throws FAILED_PRECONDITION and the run is recorded as failed. No rules
  change: deals are already server-write-only.
- **Tests.** [agents-stale-deals.test.ts](../../src/lib/server/agents-stale-deals.test.ts)
  (real sweep, pipelines, task writer and deal-service stage move over the
  in-memory Firestore) and the route's
  [route.test.ts](../../src/app/api/sub-accounts/[id]/agents/stale-deals/route.test.ts).
  Monitors page: `e2e/specs/agent-monitors.spec.ts`.
