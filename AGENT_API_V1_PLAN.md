# Agent API v1

> Status: **PLAN 2026-09-24** (nothing built). Owner rulings locked: sub-account
> `lsk_` keys first (agency-wide keys are a later PR of this programme); one tool
> registry (`src/lib/ai-suite/capabilities.ts`) exposed over MCP + a REST mirror;
> outbound-to-humans and workflow activation only ever create a **proposal** a
> human approves in-app; create/update execute directly, hard deletes are
> queued; every agent write keeps the existing fuses (rate limit, idempotency,
> enrolment cap); agent keys get their own scope.

## Goal

An external LLM agent holding one `lsk_live_…` key with scope `agent` can read
and manage one sub-account's CRM over `POST /api/mcp` (Streamable HTTP, bearer
auth) or `GET/POST /api/v1/tools[/{name}]`, using exactly the capabilities the
Workspace Assistant already has plus new ones for the resources it lacks.
Nothing reaches a real person, activates automation or hard-deletes a record
until a member approves it on `/sa/[id]/approvals`.

## Findings that shape the plan (verified in code, 2026-09-24)

- `src/lib/api/auth.ts::authenticateApiRequest` already does key lookup,
  constant-time hash, revocation, the `apiAccessEnabledByAgency` kill-switch,
  version pin and `lastUsedAt`; `withApiAuth` adds scope, rate limit,
  idempotency and `captureRequestLog`. `checkRateLimit` / `requireApiScope` /
  `captureRequestLog` are exported, so a non-`withApiAuth` route (MCP) can
  compose the same lifecycle.
- `AiSuiteActionContext` is `{uid, email, displayName, agencyId, subAccountId?,
  subAccountRole?}`; territory scoping short-circuits to "see everything" for
  role `admin`/`agencyOwner` (`loadEffectiveTerritoryScope`), so a key-derived
  ctx with `subAccountRole: "admin"` needs no membership doc.
- The registry is one 4,311-line file; `scripts/check-capability-tenancy.mjs`
  parses **that one path**. New capabilities must live in per-resource files,
  so the checker must learn a directory first (PR2).
- **Deletes are hard, not soft**: `deals-service.ts:578 ref.delete()`,
  `workflows-service.ts:485 ref.delete()`, `contact-delete.ts` recursive
  delete; resource routes (`products`, `pipelines`, `custom-fields`,
  `booking-pages`, `snippets`, `social/posts`, …) call `.delete()` inline. No
  `deletedAt`/`archivedAt` anywhere under `src/lib/server` or the routes. Ruling
  4 therefore applies: every delete is queued.
- Outbound seams that exist as services: `conversation-send/index.ts::
  sendConversationMessage` (email/sms/whatsapp/messenger/instagram),
  `quote-send-service.ts::sendQuoteServerSide`, `reviews/request.ts::
  maybeSendReviewRequest`, `scheduled-messages/service.ts::
  scheduleConversationMessage`, `whatsapp/template-dispatch.ts::
  dispatchWhatsappTemplateSend`, `voice/vapi.ts::createOutboundCall`. Broadcast
  send and social publish live **inline in routes** (`/api/broadcasts/email/
  send`, `/api/sub-accounts/[id]/social/posts`) and need extraction.
- `@modelcontextprotocol/sdk` 1.27.1 is in `pnpm-lock.yaml` only transitively
  (via `shadcn`); it must become a direct dependency. Stateless web-standard
  transport (`WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator:
  undefined`) plus the low-level `Server` with `tools/list` + `tools/call`
  handlers accepts **raw JSON Schema** `inputSchema` — which is what the
  registry's `parameters` already are, so no zod re-declaration. (Verified
  against context7 docs; the v1 import path is
  `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` — re-check at
  PR5 since v2 splits into `@modelcontextprotocol/server`.)
- `auditEvents` already has actor type `api_key` and `ai_agent`
  (`src/lib/audit/types.ts`); `aiSuiteActions` is the per-capability audit
  row. Both get reused, no new audit collection.

## Module shape

```
src/types/api.ts                       ApiKeyScope += "agent"
src/lib/api/rate-limit.ts              LIMITS_BY_SCOPE.agent = {perMinute:60, perHour:1000} (= admin)
src/lib/api/agent-context.ts           buildAgentContext(ApiAuthContext) → AiSuiteActionContext (NEW)
src/lib/api/agent-dispatch.ts          dispatchAgentTool(ctx, name, args) (NEW) — the ONE choke point
src/lib/ai-suite/capabilities.ts       registry index: types + AI_SUITE_CAPABILITIES + helpers (shrinks)
src/lib/ai-suite/capabilities/*.ts     per-resource capability files (NEW; ≤300 lines each)
src/lib/server/agent-proposals.ts      create / list / decide / expire proposals (NEW)
src/app/api/mcp/route.ts               POST only; bearer lsk_; stateless MCP server per request (NEW)
src/app/api/v1/tools/route.ts          GET list (NEW)
src/app/api/v1/tools/[name]/route.ts   POST call, withApiAuth({requireScope:"agent"}) (NEW)
src/app/api/sub-accounts/[id]/agent-proposals/route.ts               GET list (session auth)
src/app/api/sub-accounts/[id]/agent-proposals/[proposalId]/route.ts  POST {decision:"approve"|"reject"}
src/app/(dashboard)/sa/[subAccountId]/approvals/page.tsx             max-w-5xl (NEW)
src/components/dashboard/sidebar.tsx   "Approvals" entry + pending count badge
src/middleware.ts                      PUBLIC_PATHS += "/api/mcp"
scripts/check-capability-tenancy.mjs   accept a directory; MIN_EXPECTED stays a floor
firestore.rules / firestore.indexes.json   agentProposals (below)
docs/features/agent-api.md             feature spec (written in PR14, linked from CLAUDE.md Features)
```

### Registry extension (backwards compatible)

`AiSuiteCapability` gains two optional fields:

- `surfaces?: ("chat" | "agent")[]` — default `["chat", "agent"]`. Chat-only
  (`my_access`, `open_workspace`, `invite_member`, website/community builders,
  `research_website_reference`) set `["chat"]`. Agency-level capabilities are
  never agent-surfaced in v1 (`level !== "sub-account"` is refused).
- `approval?: "outbound" | "workflow_activate" | "hard_delete"` — the class of
  human gate. **Invariant enforced by `dispatchAgentTool`:** when `approval` is
  set, the agent surface never calls `execute`; it writes a proposal. `execute`
  is only ever called from the approve route, with the *approver's* session ctx.
  The chat surface keeps its existing confirm card (the human is the caller).

### ctx-from-key adapter (`buildAgentContext`)

```
uid:            `apikey:${keyPrefix}`   // same convention as /api/v1/contacts createdByUid
email:          ""                      // no reply-to fallback; sends need a human approver anyway
displayName:    key name
agencyId / subAccountId: from the key doc (never from args)
subAccountRole: "admin"                 // tenant-wide; territory scope = enforce:false
apiKey:         { keyId, keyPrefix, mode, enrolmentCapPerHour }   // NEW optional field on AiSuiteActionContext
```

Refusals before any tool runs: scope ≠ `agent` → `insufficient_scope`;
`mode === "test"` → `test_mode_unsupported` (v1 agent keys are live-only; the
test namespace exists only for contacts/deals/tasks/events and the registry
hard-codes `mode: "live"`); `subAccounts/{id}.agentApiEnabledByAgency !== true`
→ `agent_api_disabled` (403). Capabilities that create contacts or apply tags
read `ctx.apiKey` and pass through `openEnrolmentGate` exactly as
`/api/v1/contacts` does — the cap fires only for key-driven callers.

### Feature gate — new `agentApiEnabledByAgency`

Reusing `apiAccessEnabledByAgency` alone was rejected: a Zapier key can touch
~6 resources; an agent key can touch ~30 and file proposals to message
customers. The agency owner must opt a sub-account in explicitly. Both gates
must be on (`apiAccess` is checked inside `authenticateApiRequest` already).
5-step wiring per `docs/architecture/feature-gates.md`: `SubAccountDoc` field
(`=== true`); `false` at both creation sites; `wantsAgentApi` branch in
`PATCH /api/agency/sub-accounts/[id]/feature-gates`; runtime 403 in
`buildAgentContext`; checkbox in `SubAccountManageDialog`; entry `"agent-api"`
in `FEATURE_GATES`. Add to `PLAN_GATE_KEYS` (not pre-ticked). Turning it off
tears nothing down; pending proposals stay pending and cannot be approved
while off (approve route re-checks).

### Approval queue — `agentProposals/{id}` (top-level collection)

| Field | Notes |
|---|---|
| `agencyId`, `subAccountId`, `createdByUid` | tenancy keys per auth-and-tenancy.md; `createdByUid = apikey:<prefix>` |
| `keyId`, `keyPrefix` | which key proposed it |
| `capability`, `args`, `summary` | `args` are the **validated** args; `summary` from `cap.summarize` |
| `approval` | `outbound` / `workflow_activate` / `hard_delete` |
| `contactId?`, `channel?`, `targetRef?` | denormalised for the list UI + territory gate on approve |
| `status` | `pending` → `approved`+`executed` / `failed`, or `rejected`, or `expired` |
| `idempotencyKey?` | dedupes a retried proposal while one is `pending` (same cap+args hash) |
| `createdAt`, `expiresAt` (+7 d), `decidedAt?`, `decidedByUid?`, `decidedByEmail?` | |
| `result?` `{resultText, ref}` / `error?` | outcome of `execute` |

Rules: `allow read: if canAccessSub(resource.data.subAccountId,
resource.data.agencyId); allow write: if false;` (Admin SDK only, like
`broadcasts`). Index: `(subAccountId ASC, status ASC, createdAt DESC)`.
`firebase deploy --only firestore:rules,firestore:indexes` after PR3 merges
(check open PRs first — memory: rules deploy dropped SP3 rules once).
Expiry: the existing daily public-API TTL sweep (middleware comment line 38)
gains an `agentProposals` pass that flips `pending` past `expiresAt` to
`expired`.

### Approve path

`POST /api/sub-accounts/[id]/agent-proposals/[proposalId]` (session auth):
`requireSubAccountMember` for `outbound`/`workflow_activate`,
`requireSubAccountAdmin` for `hard_delete` (mirrors the DELETE routes);
territory gate on `contactId` when present; re-check both agency gates; load
proposal, assert `subAccountId` matches the route; re-run `cap.validate(args)`;
build the **approver's** ctx exactly as `/api/ai-suite/confirm` does; call
`cap.execute` — e.g. `send_message.execute` calls `sendConversationMessage({…,
actor:{uid: approver.uid, email: approver.email}})`, so quiet hours, opt-out,
24-h WhatsApp window and channel readiness are all decided at approve time by
the existing seam; write `aiSuiteActions` row + proposal status in one batch;
reject just stamps `rejected`. Nothing new touches a provider.

### Transport routes

- **`POST /api/mcp`** — per request: `authenticateApiRequest` → agent-scope +
  gate checks (`buildAgentContext`) → `checkRateLimit({scope:"agent"})` → new
  low-level `Server({capabilities:{tools:{}}})` whose `tools/list` maps
  `agentTools(ctx)` (name, description, `inputSchema = cap.parameters`,
  `annotations: {readOnlyHint: cap.readonly === true}`) and whose `tools/call`
  calls `dispatchAgentTool` and returns `{content:[{type:"text", text:
  JSON.stringify(result)}]}` (`isError` on `CapabilityUserError`) → connect
  `WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined})`
  → `handleRequest`. Each tool call is logged via `captureRequestLog` with
  `path = "/api/mcp#" + name`. GET/DELETE answer 405. No idempotency on MCP in
  v1 (clients that need it use the REST mirror).
- **`GET /api/v1/tools`**, **`POST /api/v1/tools/{name}`** — `withApiAuth(…,
  {requireScope:"agent"})`; the POST body is the args; `Idempotency-Key`
  honoured by the existing wrapper. Response shapes via `apiOk`/`apiError`;
  a proposal returns `202 {proposal:{id,status:"pending",summary}}`.

## Capability inventory

R = read (executes now) · W = write (executes now) · Q = queued proposal.
"Extract" = the logic lives in a route today and must move to a
`src/lib/server/*-service.ts` (route becomes a thin caller, same as SP2 d).

| Resource | Capabilities (class) | Service | Exists? |
|---|---|---|---|
| Contacts | `find_contacts` R · `create_contact` W · `get_contact` R · `update_contact` W · `add_tags`/`remove_tags` W (enrolment cap) · `delete_contact` Q | `contacts-service`, `contact-delete` | yes |
| Companies | `list_companies` R · `create_company`/`update_company` W · `delete_company` Q | `companies-service` (delete only) | extract create/update from `/api/companies` |
| Deals / pipelines | `find_deals` R · `create_deal`/`update_deal`/`move_deal_stage` W · `delete_deal` Q · `list_pipelines`/`get_pipeline` R · `create_pipeline`/`update_pipeline` W · `delete_pipeline` Q | `deals-service`, `lib/pipelines/server` | pipeline create/update/delete: extract from `sub-accounts/[id]/pipelines` |
| Tasks | `find_tasks` R · `create_task`/`complete_task` W · `update_task` W · `delete_task` Q | `tasks-service` | update/delete: extract from `/api/tasks/[id]` |
| Events / bookings | `find_events` R · `create_event` W · `set_event_status` W, **Q when `cancelled`** (attendee email) · `list_booking_pages`/`get_booking_page` R · `create_booking_page`/`update_booking_page` W · `delete_booking_page` Q | `events-service`, `event-status-service`, `lib/booking/validation` | booking page CRUD: extract from `sub-accounts/[id]/booking-pages` |
| Conversations | `find_conversations` R · `get_conversation` R (messages across `contacts/{id}/{messages,emailMessages,whatsappMessages}`) · `set_conversation_status`/`set_bot_mode` W · `send_message` Q (email/sms/whatsapp/messenger/instagram) · `send_whatsapp_template` Q · `list_scheduled_messages` R · `schedule_message` Q · `cancel_scheduled_message` W | `conversation-send`, `template-dispatch`, `scheduled-messages/service`, `conversations-service` | new read service `conversations-read.ts`; template send: extract precheck from `/api/comms/whatsapp/send-template` |
| Workflows | `list_workflows`/`get_workflow`/`list_workflow_runs` R · `create_workflow`/`update_workflow` W (nodes, trigger, folder) · `set_workflow_status` W for `paused`/`draft`, **Q for `active`** · `delete_workflow` Q | `workflows-service` | yes |
| Custom fields | `list_custom_fields`/`list_custom_field_folders` R · `create_custom_field`/`update_custom_field`/`create_folder`/`update_folder`/`reorder_folders` W · `delete_custom_field`/`delete_folder` Q | `lib/custom-fields/{validation,folders}` | extract from both routes |
| Products | `list_products` R · `create_product`/`update_product` W · `delete_product` Q | `lib/products/sanitize` | extract from `sub-accounts/[id]/products` |
| Quotes | `list_quotes`/`get_quote` R · `create_quote`/`update_quote` W · `send_quote` Q · `mark_quote_paid` W | `quote-send-service`, `quotes-service`, `lib/quotes/{sanitize,number}` | create/update: extract from the 229-line route |
| Invoices (recurring) | `list_recurring_schedules` R · `create_recurring_schedule` **Q** (first cycle emails the customer) · `update_recurring_schedule`/`pause_recurring_schedule` W | `recurring-invoice-service`, `lib/recurring/schedule-input` | extract create/update from route |
| Snippets / templates | `list_snippets` R · `create_snippet`/`update_snippet` W · `delete_snippet` Q · `list_whatsapp_templates` R | `lib/snippets/validate` | extract snippet CRUD |
| Tracked links | `list_tracked_links` R · `create_tracked_link` W | — | extract from route |
| Social planner | `list_social_posts` R · `create_social_post` W (**status forced `draft`**) · `schedule_social_post` Q (sets `scheduled` + QStash) · `delete_social_post` Q | — | extract from `sub-accounts/[id]/social/posts` |
| Reputation | `reputation_overview` R · `list_reviews` R · `send_review_request` Q | `lib/reputation/overview`, `reviews/request` | reviews list: extract query from `gbp/reviews` |
| Broadcasts | `list_broadcasts` R · `create_broadcast` Q (proposal holds audience filter + body; approve runs the send) | — | extract `/api/broadcasts/email/send` into `broadcast-send-service.ts` |
| Voice | `start_voice_call` Q | `voice/vapi::createOutboundCall` + `outbound-compliance` | extract from `/api/comms/voice/call` |
| Media | `list_media` R | — | read-only query |
| Webhooks / members | `list_webhooks`/`create_webhook`/`update_webhook_url`/`send_webhook_test` W · `list_members` R · `workspace_stats` R | existing | yes |

Excluded from the agent surface in v1: `invite_member` (staff email),
website/community/course builders, `open_workspace`, `my_access`,
`research_website_reference`, checkout pages, payment links/mandates, API-key
management, feature gates, anything agency-level.

## PR DAG (build order; each ≤ ~500 lines incl. tests)

| PR | Depends | Content | `verify:` |
|---|---|---|---|
| **PR1** scope + gate | — | `"agent"` scope (types, `VALID_SCOPES`, rate-limit table, mint UI + `SCOPE_HELP`); `agentApiEnabledByAgency` 5-step; `FEATURE_GATES["agent-api"]`; `PLAN_GATE_KEYS` | `api-keys/route.test.ts`: minting `["agent","forms-ingest"]` → 400; `feature-gates/route.test.ts`: PATCH `agentApiEnabled` writes the field and an audit row; `agency-manage-gates.spec.ts` gains the checkbox |
| **PR2** registry seams | — | `surfaces`/`approval` fields; split registry into `capabilities/*.ts` (pure move, no behaviour change); checker accepts a dir; `buildAgentContext`; `dispatchAgentTool`; shared test harness `src/test/two-tenant-db.ts` (fake Admin DB seeded with `sa1`/`sa2`) | `agent-dispatch.test.ts`: chat-only cap → `not_available`; agency-level cap → refused; `approval` cap → proposal written and `execute` **never invoked** (spy); test-mode key → `test_mode_unsupported`; gate off → 403; `check-capability-tenancy.mjs` still counts ≥ 25 caps after the split |
| **PR3** approval queue | PR2 | `agent-proposals.ts`; rules + index; list/decide routes; expiry pass; `aiSuiteActions` row on execute | `agent-proposals.firestore-rules.test.ts` (member of `sa2` cannot read `sa1` rows, client write denied); `decide/route.test.ts`: approve on foreign `subAccountId` → 404, approve runs `cap.execute` with the **approver's** uid and `sendConversationMessage` mock is called exactly once; reject never calls it; hard_delete by collaborator → 403 |
| **PR4** REST mirror | PR2, PR3 | `/api/v1/tools`, `/api/v1/tools/[name]` | `tools/route.test.ts`: admin-scope key → `insufficient_scope`; unknown tool → 404; queued cap → 202 + proposal id; `Idempotency-Key` replay returns the cached 202 without a second proposal |
| **PR5** MCP route | PR4 | direct dep `@modelcontextprotocol/sdk`; `/api/mcp`; middleware public path; per-call request log | **MCP-client integration test** `mcp/route.mcp-client.test.ts`: real `Client` + `StreamableHTTPClientTransport` with `fetch` bound to the route handler (no socket); asserts `listTools()` names == agent-surfaced registry, `callTool("find_contacts")` returns sa1 data only, `callTool("send_message")` returns a proposal id and the send spy count is 0, bad bearer → 401 JSON-RPC error |
| **PR6** approvals UI | PR3 | `/sa/[id]/approvals` (max-w-5xl; loading/empty states wrapped), sidebar entry + badge, approve/reject buttons | `e2e/specs/agent-approvals.spec.ts`: seed a pending proposal via Admin SDK, approve in browser, row flips to `executed`; the outbound seam is stubbed via the existing E2E Twilio/SMTP fixtures |
| **PR7** contacts + companies pack | PR2 | `get/update_contact`, `add/remove_tags` (enrolment gate), `delete_contact` Q, companies CRUD extraction | `contacts.tenancy.test.ts`: every cap given an `sa2` id from an `sa1` ctx → `CapabilityUserError`, zero writes; `add_tags` over cap → `enrolment_cap_exceeded` |
| **PR8** conversations pack | PR3 | `conversations-read.ts`, `find/get_conversation`, `send_message`, `send_whatsapp_template`, `schedule_message`, `cancel_scheduled_message` | `outbound-never-sends.test.ts` (**programme-wide**): for every registered cap with `approval`, dispatch it through the agent surface with `conversation-send`, `quote-send-service`, `reviews/request`, `template-dispatch`, `vapi`, `qstash` all spied — total call count 0, one proposal each; plus a static check that any `capabilities/*.ts` importing one of those modules declares `approval` |
| **PR9** workflows + pipelines + deals pack | PR2 | `set_workflow_status` (Q on `active`), `delete_workflow` Q, pipeline CRUD extraction, `update/delete_deal` | `workflows.tenancy.test.ts`; `set_workflow_status` to `active` → proposal, to `paused` → direct write + `workflow.status_changed` audit row with actor `api_key` |
| **PR10** fields + products + snippets pack | PR2 | custom-field/folder, product, snippet CRUD extractions | per-pack tenancy test; `validateFieldDefInput` rejection surfaces as `CapabilityUserError` not 500 |
| **PR11** quotes + recurring pack | PR3 | quote create/update extraction, `send_quote` Q, `mark_quote_paid`, recurring schedule caps | tenancy test; `send_quote` approve calls `sendQuoteServerSide` with `actor` = approver |
| **PR12** events + booking pages pack | PR3 | `update_task`/`delete_task`, `set_event_status` (Q on cancelled), booking page CRUD extraction | tenancy test; cancelling routes through the proposal, rescheduling does not |
| **PR13** social + reputation + broadcasts + voice pack | PR3 | broadcast send extraction, social post extraction, `send_review_request`, `start_voice_call` | tenancy test; `create_social_post` with `status:"scheduled"` in args still lands as `draft` |
| **PR14** docs + live validation | all | `docs/features/agent-api.md`, `public-api.md` scope section, CLAUDE.md link, `AGENT_API_V1_PLAN.md` status flip | live checklist below, evidence in the PR body (redacted) |

Later PR (out of v1): agency-wide keys (sub-accounts, plans, gates, snapshots).

## Firestore changes

- `firestore.rules`: `match /agentProposals/{id}` (read `canAccessSub`, write
  `false`). `apiKeys` rule unchanged (server-only).
- `firestore.indexes.json`: `agentProposals (subAccountId, status, createdAt
  DESC)`; conversations read may need `(subAccountId, updatedAt DESC)` — check
  the existing conversations indexes before adding.
- Deploy rules + indexes together after PR3 and again if PR8 adds an index.

## Live validation (after PR14, prod sub-account #1000, no real contacts)

1. Agency owner enables `agentApiEnabledByAgency` for #1000 in the Manage
   dialog; mint an `agent` key on #1000's Settings → API keys.
2. `claude mcp add --transport http leadstack https://crm.crestahq.com/api/mcp
   --header "Authorization: Bearer lsk_live_…"` — `listTools` shows the agent
   set; `find_contacts` returns #1000 data; a second key from a different
   sub-account gets `not found` for a #1000 contact id.
3. `create_contact` "Agent API smoke <ts>" → visible in Contacts.
4. `send_message` (sms) to that contact → 202/proposal; row on `/sa/1000/
   approvals`; approve in the browser → SMS lands on the test handset; proposal
   `executed`; `aiSuiteActions` row with the approver's uid.
5. `delete_contact` → proposal → approve → contact gone. `set_workflow_status
   active` → proposal → reject → workflow still `draft`.
6. REST: `POST /api/v1/tools/find_contacts` with the same key, then with an
   `admin`-scope key (expect `insufficient_scope`).
7. Screenshots redacted before commit (memory: PII in evidence).

## Open risks

- **Registry split is a 4,300-line move.** Pure-move PR with the checker's
  floor as the only behavioural assertion; a blind reviewer must diff symbol
  lists, not read the moves.
- **MCP SDK version.** Lockfile has 1.27.1 via shadcn; v2 renames packages.
  Pin `^1.27` and re-verify the import path at PR5; if v2 lands first, use
  `@modelcontextprotocol/server`'s `createMcpHandler`.
- **Agent acts as sub-account admin.** Territory scoping is bypassed by design
  (a key is not a member). Approvals re-apply the *approver's* territory gate,
  so a scoped collaborator cannot approve a send to a contact they can't see.
- **No idempotency on MCP.** A retried `create_contact` over MCP can duplicate;
  documented, REST mirror covers it. Proposal dedupe only covers queued calls.
- **Rate limit is per-process memory** (fine on the single `crestahq` systemd
  unit; wrong on multi-instance buyer deploys — already true for `/api/v1`).
- **Extraction PRs change live routes.** PR7–13 each move route logic into a
  service; routes stay byte-identical in response shape and keep their existing
  route tests. Any extraction without a pre-existing route test gets one first.
- **Broadcast approve runs a fan-out.** The proposal snapshot of the audience
  filter is re-resolved at approve time, so the recipient set is the one the
  approver sees, not the one the agent saw.
- **Approvals can pile up.** 7-day expiry + a badge; no notification in v1
  (push/email alert is a candidate follow-up once volume is known).
- **Agency-wide keys** are deliberately deferred; the `level` refusal in
  `dispatchAgentTool` is the seam they will open.
