# Custom Agents v1 — Inbox Follow-up Watchdog (BUILT 2026-07-12)

> **STATUS: BUILT** (same day as scope lock). Implementation notes vs this
> plan: agent docs live at TOP-LEVEL `customAgents/{subAccountId}` (doc id =
> sub-account id) rather than a subcollection — the plan explicitly left the
> fan-out shape open, and top-level avoids both a collection-group index AND
> any rules deploy (server-only collection; config/runs read via the admin
> API). Everything else matches. Remaining deploy step:
> `firebase deploy --only firestore:rules,firestore:indexes` (the
> conversations composite index). Not yet verified against live QStash +
> OpenRouter — see the verification checklist at the bottom.

> Scope locked 2026-07-12. One templated autonomous agent per sub-account: the
> **Inbox Follow-up Watchdog**. It monitors the unified inbox on an hourly
> cron, uses the LLM to judge which unanswered inbound conversations need a
> human, and alerts via **Task + push notification**. Its only powers are
> additive-internal (create task, notify, activity row) — it can never mutate
> records or contact a customer, so it is safe to ship in "act" mode with no
> confirm step. This is deliberately the smallest slice that exercises the
> full future agent architecture (trigger → pre-filter → LLM judge → action →
> run log → caps).

## Why this slice

- **Safe by construction.** The worst possible failure is a noisy or missed
  notification. No writes to customer-facing surfaces, no record mutation,
  no money. Phase 2 (deal tagger — the first mutation) inherits the harness
  plus a `suggest` mode + `agentSafe` capability flag; NOT in v1.
- **Cost-bounded.** A deterministic Firestore pre-filter shortlists stale
  conversations; the LLM only judges the shortlist (capped). Most hourly runs
  make zero LLM calls.
- **Demo-strong.** Extends the existing speed-to-lead push story to "the AI
  noticed you dropped the ball" — something deterministic workflows can't do
  (they detect silence; only the LLM judges whether *this* thread matters).

## Locked decisions

| Decision | Locked choice |
|---|---|
| Agent set | ONE template: Inbox Follow-up Watchdog. No free-form agents, no deal tagger. |
| Autonomy | "act" from day one (safe because actions are additive-internal only). |
| Actions | Create Task + push notification + activity row on the contact. NO email in v1. NO record mutation. NO customer-facing sends (structural, not config). |
| Trigger | ONE global hourly QStash cron (`0 * * * *`) fanning out over enabled agents. No event-driven trigger in v1. |
| Judge model | `callAi()` default (Haiku) — no per-agent model override in v1. |
| Gate | TWO gates, different jobs: `labsEnabledByAgency` (BUILT 2026-07-12) controls the SURFACE — whether the sub-account sees the Labs section at all; `aiSuiteEnabledByAgency` controls the SPEND — the watchdog's runtime guard checks it every run (= "this workspace may spend the agency's AI credits"). A dedicated `customAgentsEnabledByAgency` gate is deferred until agents graduate out of Labs. |
| UI home | The **Labs** section (`/sa/[id]/labs` — gated sidebar entry, BUILT 2026-07-12 with a "Coming soon" watchdog card). The watchdog config card replaces that placeholder; card styled like the channel sections. Admin-only writes. Labs signals pre-release status explicitly; the agent graduates to the AI Agents nav when proven. |
| Quiet hours | Optional per-agent window: push is suppressed inside it, the Task is still created. Default: off. |

## Data model

### `subAccounts/{id}/customAgents/inbox-watchdog` (singleton doc, admin-config)

```ts
interface InboxWatchdogDoc {
  enabled: boolean;                 // master switch; default false
  thresholdHours: number;           // 1–24, default 3 — inbound age before judging
  instructions: string | null;      // optional free-text criteria fed to the judge
                                    // (≤ 1000 chars), e.g. "prioritise anything
                                    // mentioning price or cancellation"
  quietHours: { startHour: number; endHour: number; timezone: string } | null;
  dailyTokenBudget: number;         // default 20_000; run skips when exceeded
  totalTokensUsed: number;          // lifetime counter (channel-doc pattern)
  createdAt / updatedAt;
}
```

Rules: member read, server-only write (Admin SDK routes) — same shape as
`aiAgent/{channel}` docs.

### `subAccounts/{id}/customAgents/inbox-watchdog/runs/{runId}` (run log)

```ts
interface AgentRunDoc {
  status: "completed" | "skipped" | "failed";
  skippedReason: string | null;     // "gate_off" | "budget_exceeded" | ...
  scanned: number;                  // conversations matching the pre-filter
  judged: number;                   // LLM calls actually made (≤ cap)
  flagged: number;                  // judged true → alerted
  actions: Array<{ contactId: string; taskId: string; reason: string }>;
  tokensUsed: number;
  startedAt / finishedAt;
}
```

Mirrors `automation_executions`: sub-account read, server-only write. Keep the
last N; the daily `api-cleanup` cron gains a sweep for runs older than 30 days.

### `conversations/{contactId}` — ONE new server-only field

```ts
watchdogAlertedAt: Timestamp | null;  // dedupe: set when alerted; the pre-filter
                                      // skips conversations where this is AFTER
                                      // lastMessageAt (i.e. no new inbound since
                                      // the last alert)
```

A new inbound message after an alert naturally re-arms the conversation
(`lastMessageAt` moves past `watchdogAlertedAt`). No extra state machine.

### Firestore indexes — ONE new composite

`conversations(subAccountId ASC, lastDirection ASC, lastMessageAt ASC)` in
`firestore.indexes.json`. **Deploy step required:**
`firebase deploy --only firestore:rules,firestore:indexes`.

## Execution flow (the harness)

`POST /api/agents/watchdog/step` — QStash signature-verified (same pattern as
`/api/automations/step`), added to middleware `PUBLIC_PATH_PATTERNS`.

1. **Fan-out**: collection-group query on `customAgents` docs where
   `enabled == true` (or iterate sub-accounts; pick whichever avoids a new
   collection-group index — implementation detail). For each sub-account:
2. **Guards** (all skip → run doc with `skippedReason`, never throw):
   - `labsEnabledByAgency === true` (Labs off pauses the experiment — the
     config card is unreachable, so the agent must stop too)
   - `aiSuiteEnabledByAgency === true` on the sub-account doc (AI spend)
   - `aiIsConfigured()` (OpenRouter key present)
   - daily token budget not exceeded
3. **Pre-filter** (deterministic, no LLM):
   `conversations` where `subAccountId == X`, `lastDirection == "inbound"`,
   `lastMessageAt <= now - thresholdHours`. In memory: drop `status ==
   "closed" | "snoozed"`, drop `watchdogAlertedAt >= lastMessageAt` (already
   alerted, nothing new). Cap shortlist at **20 per run** (oldest first;
   `log` the drop count in the run doc).
4. **LLM judge** per shortlisted conversation: load the last ~5 messages from
   the contact's channel subcollection(s) (reuse the thread-merge read the
   inbox detail uses), build a compact prompt: business context (agent
   profile businessName), the operator's `instructions`, the thread excerpt.
   Ask for strict JSON: `{ needsFollowUp: boolean, urgency: "high"|"normal",
   reason: string (≤140 chars) }`. Parse defensively; unparseable → treat as
   `needsFollowUp: false` (fail quiet, log in run doc).
5. **Act** on `needsFollowUp: true`:
   - `createTaskServerSide` — title `Follow up with {contactName} — {reason}`,
     due end-of-today, `contactId` linked. (Fires the existing task webhook
     events for free.)
   - `sendPushForEvent` — title `⏰ Follow-up needed: {contactName}`, body =
     reason, `url: /sa/{id}/conversations/{contactId}`,
     `tag: watchdog-{contactId}` (collapses repeat alerts). Suppressed inside
     quiet hours (Task still created).
   - Activity row on the contact (`type: "ai_agent_flagged"`), same
     best-effort pattern as `logActivity` in `ai/respond.ts`.
   - Stamp `conversations/{contactId}.watchdogAlertedAt = now`.
6. **Record**: write the run doc; increment `totalTokensUsed`.

Route budget: the whole run must stay comfortably inside a serverless
timeout — shortlist cap 20 + Haiku keeps worst case ~30–60s; process
sub-accounts sequentially and re-enqueue via QStash if the fan-out list is
large (follow the broadcasts fan-out pattern if needed; NOT expected at
current fleet sizes).

### Cron registration

Append to `SCHEDULES` in `src/lib/qstash/register-schedules.ts`:
`{ scheduleId: "leadstack-agents-watchdog", path: "/api/agents/watchdog/step",
cron: "0 * * * *", description: "Hourly inbox follow-up watchdog sweep." }`.
Auto-registers on cold start; zero buyer setup.

## UI (one card, inside Labs)

The Labs container is ALREADY BUILT (2026-07-12): gated `/labs` sidebar entry
(`labsEnabledByAgency` + `labsHiddenWhenDisabled`, standard wiring incl.
Manage dialog, plans, assistant gate map) with a "Coming soon" watchdog card
at `src/app/(dashboard)/sa/[subAccountId]/labs/page.tsx`. The build replaces
that placeholder with a `watchdog-section.tsx` config card mirroring the
channel-section pattern (`whatsapp-channel-section.tsx` is the closest
template):

- Enable toggle (blocked with the standard message when the AI Suite gate is
  off — reuse the "Locked by your agency" card pattern)
- Threshold select (1/2/3/6/12/24 h; default 3)
- Optional instructions textarea (≤1000 chars)
- Quiet hours (off by default; start/end/timezone — reuse send-window UI bits)
- Read-only "Last run" summary from the newest run doc (scanned/judged/flagged
  + relative time) and a small runs list (last 10)

API: `GET/PATCH /api/sub-accounts/[id]/agents/watchdog` (admin-only,
`requireSubAccountAdmin`; PATCH validates + clamps all fields server-side).

## Safety model (v1 invariants — do not relax without a new plan)

1. The watchdog physically cannot send anything to a customer or mutate any
   record other than: create Task, create activity row, stamp
   `watchdogAlertedAt`, write its own run/agent docs.
2. All reads tenant-scoped by `subAccountId` (the pre-filter query + thread
   reads); the harness takes `subAccountId` from the agent doc's path, never
   from any model output.
3. LLM output is data, not instructions: strict-JSON parse, length-clamped
   `reason`, no tool-calling — the judge cannot choose actions, only classify.
4. Budgets: ≤20 judgments/run, per-agent daily token budget, hourly cadence.
   Kill switch = the `enabled` toggle (takes effect next run).
5. Gate: `aiSuiteEnabledByAgency` checked EVERY run (agency flip-off takes
   effect within the hour).
6. Every run leaves a run doc; every alert leaves an activity row + Task.

## Explicitly OUT of v1

- Deal monitor / tagger (first mutation — phase 2, introduces `suggest` mode
  + `agentSafe` registry flag)
- Free-form user-defined agents; multiple agent instances
- Event-driven triggers (`message.received` fan-in)
- Email alerts; configurable alert channels
- Dedicated `customAgentsEnabledByAgency` gate + plan bundling (phase 2)
- Per-agent model override; assistant capabilities to configure the watchdog
  (add a `FEATURE_GATES`-style capability later if asked)

## Setup contract

**No new env vars.** Reuses `OPENROUTER_API_KEY` (judge), `QSTASH_*` (cron +
signature), `NEXT_PUBLIC_VAPID_*` (push — degrades to Task-only when
unconfigured, matching `pushIsConfigured()`), Firebase. Deploy steps:
`firebase deploy --only firestore:rules,firestore:indexes` (new composite
index + rules for `customAgents` + the `watchdogAlertedAt` field remains
server-only via existing conversations rules).

## Build checklist (est. ~1.5 days)

1. Types (`src/types/custom-agents.ts`) + rules + `firestore.indexes.json`
2. `src/lib/server/agents-watchdog-service.ts` — pre-filter, judge, act, run
   log (all logic here; route stays thin)
3. `/api/agents/watchdog/step` route + middleware public-path pattern +
   `SCHEDULES` entry
4. `GET/PATCH /api/sub-accounts/[id]/agents/watchdog` config route
5. Replace the Labs page's "Coming soon" placeholder with the
   `watchdog-section.tsx` config card + runs list (Labs container itself is
   already built)
6. `api-cleanup` cron: sweep runs >30 days
7. Verify: seed a stale inbound conversation → run the step route manually →
   Task + push + activity + `watchdogAlertedAt` stamped; re-run → no
   duplicate; reply inbound again → re-arms. Gate off → run doc
   `skippedReason: "gate_off"`. `tsc` + `pnpm lint` (tenancy checker
   unaffected — no new AI Suite capability).
