# Agent API v1

> Status: **PLAN 2026-09-24, rev 2 after blind review** (nothing built). Owner
> rulings locked: sub-account `lsk_` keys first (agency-wide keys are a later
> PR); one tool registry (`src/lib/ai-suite/capabilities.ts`) exposed over MCP
> + a REST mirror; outbound-to-humans and workflow activation only ever create
> a **proposal** a human approves in-app; create/update execute directly, hard
> deletes are queued; every agent write keeps the existing fuses; agent keys get
> their own scope; **(Q) an agent-originated write goes through, but any
> ACTIVE-workflow enrolment it would cause is held as a proposal.**

## Goal

An external LLM agent holding one `lsk_live_…` key with scope `agent` can read
and manage one sub-account's CRM over `POST /api/mcp` (Streamable HTTP, bearer
auth) or `GET/POST /api/v1/tools[/{name}]`, using the capabilities the
Workspace Assistant already has plus new ones for uncovered resources. Nothing
reaches a real person, activates or enrols into automation, spends money, or
hard-deletes a record until a member approves it on `/sa/[id]/approvals`.

## Findings that shape the plan (verified in code, 2026-09-24)

- `src/lib/api/auth.ts::authenticateApiRequest` does key lookup, constant-time
  hash, revocation, the `apiAccessEnabledByAgency` kill-switch, version pin and
  `lastUsedAt`; `withApiAuth` adds scope, rate limit, idempotency and
  `captureRequestLog`. `checkRateLimit` / `requireApiScope` /
  `captureRequestLog` are exported, so the MCP route can compose the lifecycle.
- `AiSuiteActionContext` is `{uid, email, displayName, agencyId, subAccountId?,
  subAccountRole?}`; territory scope short-circuits for role `admin`.
- The registry is one 4,311-line file; `scripts/check-capability-tenancy.mjs`
  parses **that one path**. New capabilities need per-resource files.
- **Deletes are hard**: `deals-service.ts:578`, `workflows-service.ts:485`,
  `contact-delete.ts` (recursive), inline `.delete()` in resource routes. No
  `deletedAt`/`archivedAt` anywhere. Every delete is queued.
- **Indirect outbound is everywhere.** `fireWorkflowTrigger` (`workflows/
  engine.ts:1284`) is called by contact create/tag, `deals-service.ts:300-316`
  (`fireDealTrigger`, no `apiKeyId` threaded), `event-status-service.ts:213`
  → `booking/lifecycle.ts:137` (completed / no_show / cancelled), and
  `quotes-service.ts:150-159` (`markQuotePaid` → `fireQuoteTrigger` **and**
  `maybeSendReviewRequest`). An active workflow then sends on its own. `FireInput`
  already has `apiKeyId?` (engine.ts:1251) and reconciles a pre-reserved
  enrolment in `finally` (engine.ts:1414) — that is the hook ruling Q uses.
- `updateWorkflowServerSide` (`workflows-service.ts:399-421`) patches `status`,
  `nodes`, `trigger` in one call — editing an ACTIVE workflow changes what runs.
- `createContactServerSide` writes `whatsappOptedOut` (`contacts-service.ts:148`)
  and `updateContactServerSide` takes a free-form patch: consent flags are
  writable unless the capability allowlists fields.
- Recurring schedule PATCH (`recurring-invoices/[recurringId]/route.ts`) covers
  pause / resume / `chargeMode`; resume emails the customer and can card-charge.
- Outbound seams that exist as services: `conversation-send::sendConversationMessage`,
  `quote-send-service::sendQuoteServerSide`, `reviews/request::maybeSendReviewRequest`,
  `scheduled-messages/service::scheduleConversationMessage`,
  `whatsapp/template-dispatch::dispatchWhatsappTemplateSend`,
  `voice/vapi::createOutboundCall`. Broadcast send and social publish are inline
  in routes and need extraction.
- `@modelcontextprotocol/sdk` 1.27.1 is in the lockfile only via `shadcn`; it
  becomes a direct dependency. Stateless `WebStandardStreamableHTTPServerTransport`
  + low-level `Server` `tools/list` / `tools/call` accept raw JSON Schema —
  the registry's `parameters` as-is. Re-verify the import path at PR5 (v2
  renames packages). The SDK is not installed in this worktree, so the reviewer's
  batch claim (webStandardStreamableHttp.js:408) could not be read; the plan
  rate-limits per `tools/call` regardless, which covers batches either way.
- `auditEvents` has actor types `api_key` / `ai_agent` (`lib/audit/types.ts`);
  `aiSuiteActions` is the per-capability row. `src/test/memory-firestore.ts`
  is the in-memory Firestore fake to reuse.

## Module shape

```
src/types/api.ts                       ApiKeyScope += "agent" (exclusive with admin AND forms-ingest)
src/lib/api/rate-limit.ts              LIMITS_BY_SCOPE.agent = {perMinute:60, perHour:1000}
src/lib/api/agent-context.ts           buildAgentContext(ApiAuthContext) → AiSuiteActionContext (NEW)
src/lib/api/agent-dispatch.ts          dispatchAgentTool(ctx, name, args) — the ONE choke point (NEW)
src/lib/ai-suite/capabilities.ts       index: types + AI_SUITE_CAPABILITIES + helpers (shrinks)
src/lib/ai-suite/capabilities/*.ts     per-resource files, ≤300 lines each (NEW)
src/lib/server/agent-proposals.ts      create / list / decide / expire / revoke-sweep (NEW)
src/lib/workflows/engine.ts            FireInput.hold?: AgentHold → proposal instead of enrol
src/lib/audit/types.ts                 AUDIT_ACTIONS += "agent.write" (every direct agent write)
src/app/api/mcp/route.ts               POST only; bearer lsk_; stateless MCP server per request (NEW)
src/app/api/v1/tools/route.ts          GET list (NEW)
src/app/api/v1/tools/[name]/route.ts   POST call, withApiAuth({requireScope:"agent"}) (NEW)
src/app/api/sub-accounts/[id]/agent-proposals/route.ts               GET list (session auth)
src/app/api/sub-accounts/[id]/agent-proposals/[proposalId]/route.ts  POST {decision}
src/app/(dashboard)/sa/[subAccountId]/approvals/page.tsx             max-w-5xl (NEW)
src/components/dashboard/sidebar.tsx   "Approvals" entry + pending badge
src/middleware.ts                      PUBLIC_PATHS += "/api/mcp"
scripts/check-capability-tenancy.mjs   accept a directory
firestore.rules / firestore.indexes.json   agentProposals
docs/features/agent-api.md             feature spec (PR14)
```

### Registry extension (backwards compatible)

`AiSuiteCapability` gains:

- `surfaces?: ("chat" | "agent")[]` — default `["chat", "agent"]` for existing
  caps. Chat-only: `my_access`, `open_workspace`, `invite_member`, website /
  community builders, `research_website_reference`, **and the three webhook
  write caps** (`create_webhook`, `update_webhook_url`, `send_webhook_test`: a
  prompt-injected agent pointing a webhook at its own URL is PII egress;
  `list_webhooks` stays readable). **New send/queue caps declare
  `["agent"]` only** — the chat surface never silently gains a send tool.
- `approval?: "outbound" | "workflow_activate" | "workflow_enrolment" |
  "hard_delete" | "spend"` — the human-gate class. **Invariant enforced by
  `dispatchAgentTool`:** when `approval` is set the agent surface never calls
  `execute`; it writes a proposal. `execute` runs only from the approve route
  with the approver's ctx. Chat keeps its confirm card.
- `agentArgs?: (args) => args` — optional per-cap narrowing applied only on the
  agent surface (e.g. `update_contact` field allowlist, `update_workflow`
  stripping `status`).

### ctx-from-key adapter (`buildAgentContext`)

```
uid: `apikey:${keyPrefix}`  email: ""  displayName: key name
agencyId / subAccountId: from the key doc   subAccountRole: "admin"
apiKey: { keyId, keyPrefix, mode, enrolmentCapPerHour }   // NEW optional ctx field
```

Refusals before any tool runs: scope ≠ `agent` → `insufficient_scope`;
`mode === "test"` → `test_mode_unsupported` (registry hard-codes `mode:"live"`);
`agentApiEnabledByAgency !== true` → `agent_api_disabled` (403); `level !==
"sub-account"` or `surfaces` lacks `"agent"` → `not_available`.

### Ruling Q — held workflow enrolment

`FireInput` gains `hold?: { keyId; keyPrefix; capability; proposalArgs }`.
Every service that fires a trigger (`contacts-service`, `deals-service::
fireDealTrigger`, `event-status-service`, `quotes-service`, tag application)
gains an optional `actor?: AgentActor` param that it forwards as
`apiKeyId` + `hold`. In `fireWorkflowTrigger`, after the normal match/filter/
re-entry evaluation picks the ACTIVE workflows the contact would enter, if
`hold` is set the engine **does not enrol**: it writes one `agentProposals`
row of kind `workflow_enrolment` per matched workflow (`{workflowId,
workflowName, contactId, triggerType, context}`) and returns them in
`outcome.held`. The underlying write (contact, deal stage, event status) has
already committed. Approve replays by calling `fireWorkflowTrigger({…stored
input, hold: undefined, onlyWorkflowId, apiKeyId})` — `onlyWorkflowId` (new)
restricts the run to the held workflow, re-runs filters and re-entry at
approve time (a contact enrolled meanwhile is skipped, not double-enrolled),
and the enrolment cap is reserved/reconciled on approve, not on propose.
Reject leaves the write in place and enrols nobody. Capabilities never see
this: it is decided at the seam, so a future service that fires a trigger
without threading `actor` is caught by the inverted test below.

### Feature gate — new `agentApiEnabledByAgency`

Layered on `apiAccessEnabledByAgency` (already checked in auth). 5-step
wiring per `feature-gates.md`; `FEATURE_GATES["agent-api"]`; in
`PLAN_GATE_KEYS` (not pre-ticked). No tear-down; pending proposals cannot be
approved while off (approve route re-checks).

### Approval queue — `agentProposals/{id}`

| Field | Notes |
|---|---|
| `agencyId`, `subAccountId`, `createdByUid` (`apikey:<prefix>`) | tenancy keys per auth-and-tenancy.md |
| `keyId`, `keyPrefix` | which key proposed it; key revoke sweeps its `pending` rows to `rejected` (`reason: key_revoked`) |
| `capability`, `args`, `summary` | validated args (post-`agentArgs`); `summary` from `cap.summarize` |
| `approval` | `outbound` / `workflow_activate` / `workflow_enrolment` / `hard_delete` / `spend` |
| `preview` | **verbatim** what will happen: full message body / subject, resolved recipient (name + masked address), channel, workflow name, amount + currency, or the doc about to be deleted — built by `cap.preview(ctx,args)` (new optional hook; required when `approval` is set) |
| `contactId?`, `channel?`, `targetRef?` | for the list UI + the approver's territory gate |
| `status` | `pending` → `executed` / `failed` / `rejected` / `expired` |
| `createdAt`, `expiresAt` (+7 d), `decidedAt?`, `decidedByUid?`, `decidedByEmail?`, `result?`, `error?` | |

Doc id is deterministic: `sha256(subAccountId|keyId|capability|canonical(args))`
truncated; a retried proposal while one is `pending` is a no-op returning the
same id (a `create` with `exists` precondition), so no dedupe query.
Rules: `allow read: if canAccessSub(resource.data.subAccountId,
resource.data.agencyId); allow write: if false;`. Index `(subAccountId ASC,
status ASC, createdAt DESC)`. Deploy rules + indexes together after PR3
(check open PRs first). Expiry rides the daily public-API TTL sweep.

### Approve path

`POST /api/sub-accounts/[id]/agent-proposals/[proposalId]`: session auth via
`requireSubAccountMember`; then **`roleSatisfies(cap.requiredRole, {agencyRoleIsOwner,
subAccountRole})` exactly as `ai-suite/confirm/route.ts:84`**, plus
`hard_delete` requires admin (mirrors the DELETE routes); territory gate on
`contactId`; re-check both agency gates; proposal `subAccountId` must equal the
route id (else 404); re-run `cap.validate(args)`; build the approver's ctx as
the confirm route does; call `cap.execute` (or the enrolment replay above);
write the `aiSuiteActions` row + proposal status in one batch. Reject only
stamps `rejected`. The approver's identity is the actor on every provider call
(`SendActor {uid, email}`), so quiet hours, opt-out, WhatsApp window and
channel readiness are decided by the existing seam at approve time.

### Audit for direct writes

Every non-approval agent write records `auditEvents` `agent.write` (actor
`api_key`, `keyPrefix`, capability, target ref, changed field names — values
redacted per `lib/audit/record.ts` rules) from `dispatchAgentTool`, in addition
to `captureRequestLog`. Request logs for **read** tools store `responseBodyJson:
null` (PII reads are not persisted; status + latency only).

### Transport routes

- **`POST /api/mcp`** — per request: `authenticateApiRequest` →
  `buildAgentContext` → low-level `Server` whose `tools/list` maps agent-surfaced
  caps (`inputSchema = cap.parameters`, `annotations.readOnlyHint`) and whose
  `tools/call` runs **`checkRateLimit({scope:"agent"})` per call** (so a
  JSON-RPC batch cannot multiply one request into N writes) then
  `dispatchAgentTool`; `WebStandardStreamableHTTPServerTransport({sessionIdGenerator:
  undefined})`. Each call logged with `path = "/api/mcp#" + name`. GET/DELETE
  → 405. No idempotency on MCP in v1.
- **`GET /api/v1/tools`**, **`POST /api/v1/tools/{name}`** — `withApiAuth(…,
  {requireScope:"agent"})`; `Idempotency-Key` honoured; a proposal returns
  `202 {proposal:{id,status,summary,preview}}`.

## Capability inventory

R = read · W = direct write (its triggered enrolments are still held, ruling Q)
· Q = proposal. "Extract" = route logic moves into a `*-service.ts`.

| Resource | Capabilities | Service / status |
|---|---|---|
| Contacts | `find_contacts` R · `get_contact` R · `create_contact` W · `update_contact` W (**agentArgs allowlist**: name, email, phone, company, address, customFields, tags — never `*OptedOut`, `source`, `attribution`; service re-checks `subAccountId`) · `add_tags`/`remove_tags` W (enrolment reserve) · `delete_contact` Q | `contacts-service`, `contact-delete` — exist |
| Companies | `list_companies` R · `create/update_company` W · `delete_company` Q | extract from `/api/companies` |
| Deals / pipelines | `find_deals` R · `create_deal`/`update_deal`/`move_deal_stage` W (thread `actor` into `fireDealTrigger`) · `delete_deal` Q · `list/get_pipeline` R · `create/update_pipeline` W · `delete_pipeline` Q | `deals-service` exists; pipeline CRUD: extract |
| Tasks | `find_tasks` R · `create/complete_task` W · `update_task` W · `delete_task` Q | update/delete: extract from `/api/tasks/[id]` |
| Events / booking pages | `find_events` R · `create_event` W · `set_event_status` — **Q for `cancelled`** (attendee email); `completed`/`no_show` are W with their booking triggers held (ruling Q) · `list/get_booking_page` R · `create/update_booking_page` W · `delete_booking_page` Q | `event-status-service` exists; page CRUD: extract |
| Conversations | `find_conversations` R · `get_conversation` R · `set_conversation_status` W · `set_bot_mode` W for `off`/`suggest`, **Q for `auto`** (AI replies to humans unattended) · `send_message` Q · `send_whatsapp_template` Q · `list_scheduled_messages` R · `schedule_message` Q · `cancel_scheduled_message` W | `conversation-send`, `template-dispatch`, `scheduled-messages` exist; new `conversations-read.ts` |
| Workflows | `list/get_workflow`, `list_workflow_runs` R · `create_workflow` W (created `draft`) · `update_workflow` W on `draft`/`paused`, **Q on `active`**; `agentArgs` strips `status` · `set_workflow_status` W for `paused`/`draft`, **Q for `active`** · `delete_workflow` Q | `workflows-service` exists |
| Custom fields | `list_custom_fields/_folders` R · create/update/reorder W · deletes Q | extract from both routes |
| Products | `list_products` R · `create/update_product` W · `delete_product` Q | extract |
| Quotes | `list/get_quote` R · `create/update_quote` W · `send_quote` Q · `mark_quote_paid` **Q** (`quotes-service.ts:150-159` fires a trigger and a review request) | `quote-send-service` exists; create/update: extract |
| Recurring invoices | `list_recurring_schedules` R · `create_recurring_schedule` Q · `update_recurring_schedule` **Q** (amount / `chargeMode` / dates change what is billed) · `pause_recurring_schedule` **Q** · `resume_recurring_schedule` **Q** (`spend`: emails + card charge) | `recurring-invoice-service`, `lib/recurring/schedule-input`; extract |
| Snippets / templates | `list_snippets` R · `create/update_snippet` W · `delete_snippet` Q · `list_whatsapp_templates` R | extract snippet CRUD |
| Tracked links | `list_tracked_links` R · `create_tracked_link` W | extract |
| Social planner | `list_social_posts` R · `create_social_post` W (status forced `draft`) · `schedule_social_post` Q · `delete_social_post` Q | extract |
| Reputation | `reputation_overview` R · `list_reviews` R · `send_review_request` Q | `reviews/request` exists; list: extract query |
| Broadcasts | `list_broadcasts` R · `create_broadcast` Q (audience re-resolved on approve) | extract `/api/broadcasts/email/send` |
| Voice | `start_voice_call` Q | `vapi::createOutboundCall` + compliance; extract route |
| Media / misc | `list_media` R · `list_webhooks` R · `list_members` R · `workspace_stats` R | exist / read-only query |

Excluded from the agent surface: webhook writes, `invite_member`, website /
community / course builders, `open_workspace`, `my_access`,
`research_website_reference`, checkout pages, payment links / mandates, API-key
management, feature gates, anything agency-level.

## PR DAG (fuses before transport; each ≤ ~500 lines incl. tests)

| PR | Depends | Content | `verify:` |
|---|---|---|---|
| **PR1** scope + gate | — | `"agent"` scope (types, `VALID_SCOPES`, exclusive with `admin` and `forms-ingest`, rate-limit row, mint UI); `agentApiEnabledByAgency` 5-step; `FEATURE_GATES["agent-api"]`; `PLAN_GATE_KEYS`; key-revoke hook stub | `api-keys/route.test.ts`: `["agent","admin"]` → 400; `feature-gates/route.test.ts`: PATCH writes the field + audit row; `agency-manage-gates.spec.ts` checkbox |
| **PR2** registry seams | — | `surfaces` / `approval` / `agentArgs` / `preview` fields; pure-move split into `capabilities/*.ts`; checker accepts a dir; `buildAgentContext`; `dispatchAgentTool` **without** proposal writes (approval caps return `not_yet_available`) | `agent-dispatch.test.ts` on `memory-firestore`: chat-only → `not_available`; agency-level → refused; test-mode → refused; gate off → 403; `capability-names.test.ts` asserts the **exact** name set before/after the split; checker floor unchanged |
| **PR3** proposals + approve | PR2 | `agent-proposals.ts` (deterministic id), rules + index, list/decide routes, expiry, revoke sweep, `aiSuiteActions` row; `dispatchAgentTool` writes proposals; **fixture capability** `__test_outbound` (test-only, `approval:"outbound"`, execute calls a spy) | `agent-proposals.firestore-rules.test.ts` (sa2 cannot read sa1; client write denied); `decide/route.test.ts`: foreign `subAccountId` → 404; `roleSatisfies` denial → 403; approve runs the fixture's execute once with the approver's uid; reject never; revoked key → pending rows `rejected` |
| **PR3b** fuses on existing caps | PR3 | `FireInput.hold` + `onlyWorkflowId` + `outcome.held` in the engine; `actor` threaded through contacts / deals / tasks / events services; `update_contact` allowlist + service `subAccountId` check; webhook writes → chat-only; `agent.write` audit row; read-tool log redaction; **inverted outbound test** | `held-enrolment.test.ts`: agent `create_contact` with a matching ACTIVE workflow → contact exists, 0 runs, 1 `workflow_enrolment` proposal; approve → 1 run, cap reserved; `outbound-never-sends.test.ts`: **every** agent-surfaced non-approval cap dispatched with Twilio, SMTP, Meta, global `fetch`, QStash publish and the workflow run-writer spied → 0 calls; every approval cap → 1 proposal, 0 calls; a static check that any `capabilities/*.ts` importing a send module declares `approval` |
| **PR6** approvals UI | PR3b | `/sa/[id]/approvals` (max-w-5xl; all states wrapped), sidebar badge, row renders `preview` verbatim (body, recipient, channel / workflow / amount) + approve / reject | `e2e/specs/agent-approvals.spec.ts`: seed a pending `send_message`-shaped fixture proposal via Admin SDK; approve in browser; assert the row's stored `result` came from a `SendOutcome.ok === true` (E2E SMTP fixture), not from "no throw" |
| **PR4** REST mirror | PR3b | `/api/v1/tools`, `/api/v1/tools/[name]` | `tools/route.test.ts`: admin key → `insufficient_scope`; unknown → 404; approval cap → 202 + id; `Idempotency-Key` replay → same 202, one proposal |
| **PR5** MCP route | PR4 | direct dep; `/api/mcp`; middleware; per-call rate limit + log | `mcp/route.mcp-client.test.ts`: real `Client` + `StreamableHTTPClientTransport` with `fetch` bound to the handler; `listTools()` == agent-surfaced set; `callTool("find_contacts")` returns sa1 only; `callTool("__test_outbound")` → proposal id, spy 0; a 3-call batch consumes 3 rate-limit tokens; bad bearer → 401 |
| **PR7** contacts + companies | PR3b | `get/update_contact`, `add/remove_tags`, `delete_contact` Q, companies extraction | `contacts.tenancy.test.ts` (sa2 id from sa1 ctx → `CapabilityUserError`, 0 writes); `update_contact` with `smsOptedOut` → arg stripped; inverted test extended |
| **PR8** conversations | PR3b | `conversations-read.ts`, `send_message`, `send_whatsapp_template`, `schedule_message`, `set_bot_mode` (Q on `auto`) | tenancy test; `set_bot_mode auto` → proposal, `suggest` → write; inverted test extended |
| **PR9** workflows + pipelines + deals | PR3b | `update_workflow` (Q on active, `status` stripped), `set_workflow_status`, `delete_workflow` Q, pipeline extraction, `update/delete_deal` | `update_workflow` on active → proposal; on draft → write; `move_deal_stage` with an active `pipeline.stage.changed` workflow → held proposal; inverted test extended |
| **PR10** fields + products + snippets | PR3b | extractions | tenancy test; validation errors → `CapabilityUserError`; inverted test extended |
| **PR11** quotes + recurring | PR3b | quote extraction, `send_quote` Q, `mark_quote_paid` Q, recurring caps (all Q except list) | `mark_quote_paid` → proposal; approve calls `markQuotePaidServerSide` once and `maybeSendReviewRequest` fires inside it, never from the agent surface; `resume_recurring_schedule` → `spend` proposal |
| **PR12** events + booking pages + tasks | PR3b | `update/delete_task`, `set_event_status`, booking-page extraction | `cancelled` → proposal; `completed` → write + held `booking.showed` enrolment |
| **PR13** social + reputation + broadcasts + voice | PR3b | extractions, `send_review_request`, `start_voice_call` | `create_social_post` with `status:"scheduled"` lands `draft`; broadcast approve re-resolves audience |
| **PR14** docs + live validation | all | `docs/features/agent-api.md`, `public-api.md`, CLAUDE.md link, status flip | live checklist below |

Later (out of v1): agency-wide keys.

## Firestore changes

- `firestore.rules`: `match /agentProposals/{id}` (read `canAccessSub`, write `false`).
- `firestore.indexes.json`: `agentProposals (subAccountId, status, createdAt DESC)`;
  `(keyId, status)` for the revoke sweep; conversations read may need
  `(subAccountId, updatedAt DESC)` — check existing indexes first.
- Deploy rules + indexes together after PR3, again if PR8 adds one.

## Live validation (after PR14, prod sub-account #1000, no real contacts)

1. Owner enables `agentApiEnabledByAgency` for #1000; mint an `agent` key.
2. `claude mcp add --transport http leadstack https://crm.crestahq.com/api/mcp
   --header "Authorization: Bearer lsk_live_…"`; `listTools` shows the agent
   set; `find_contacts` returns #1000 data; a key from another sub-account gets
   `not found` for a #1000 contact id.
3. `create_contact` "Agent API smoke <ts>" with a tag that matches an ACTIVE
   test workflow → contact visible, **no run**, a `workflow_enrolment` row on
   `/sa/1000/approvals`; approve → run appears.
4. `send_message` (sms) → proposal; approve in browser → SMS on the test
   handset; row `executed`; `aiSuiteActions` row with the approver's uid.
5. `delete_contact` → proposal → approve → gone. `set_workflow_status active`
   → proposal → reject → still `draft`.
6. REST: `POST /api/v1/tools/find_contacts` with the agent key, then an
   `admin` key (`insufficient_scope`). Screenshots redacted before commit.

## Open risks

- **Registry split is a 4,300-line move**; the exact-name-set test is the
  behavioural assertion, reviewers diff symbol lists.
- **Ruling Q touches every trigger caller.** A service that fires a trigger
  without threading `actor` enrols silently; the inverted test spies the run
  writer so that regression is red, but only for caps the test knows — the
  static import check covers new files.
- **Held enrolments change timing.** A "speed-to-lead" workflow approved an
  hour later still runs its first step immediately; the preview says so.
- **MCP SDK version** (1.27 via shadcn; v2 renames packages). No idempotency
  on MCP; REST covers it. Rate limit is per-process memory (single unit here).
- **Agent acts as sub-account admin** (territory bypass by design); approvals
  re-apply the approver's territory gate and role.
- **Extraction PRs change live routes**; each keeps response shape and its
  route test, adding one first where none exists.
- **Approvals can pile up**; 7-day expiry + badge; no notification in v1.
