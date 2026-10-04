# Agency Agent API (Agent API phase 2)

> Status: **PLAN, rev 1 (2026-10-04)**. Builds on the live v1
> ([AGENT_API_V1_PLAN.md](AGENT_API_V1_PLAN.md), [docs/features/agent-api.md](docs/features/agent-api.md)).
> Owner rulings locked (Hein, 2026-10-04): one **agency-wide key** minted by the
> agency owner, every call names a `subAccountId`; the key reaches only sub-accounts
> with `agentApiEnabledByAgency` on, everything else is the same 404 as a nonexistent
> id; a sub-account the key creates starts with the gate on, but the key can never
> enable the gate on an existing one; revoke or the agency kill switch cuts off
> everything; **end-to-end onboarding by an agent is the headline**: create, snapshot,
> pipelines / fields / products / snippets, draft workflows and booking pages, and
> non-agent gates run directly; billing plans, charges, member invites, workflow
> activation and booking-page publish are proposals on a **new agency approvals page**
> that batches a whole run; OAuth / QR / credentials stay human-only; a **CI-enforced
> manifest** maps every route under `src/app/api/sub-accounts/**` and
> `src/app/api/agency/**` to tools or a written exclusion, with a grandfathered list
> that can only shrink. Order: coverage gate → keys + onboarding + approvals page →
> burn-down.

## Goal

An agent holding one `lsk_live_…` key minted at `agencies/{agencyId}/apiKeys` calls
the same `POST /api/mcp` and `/api/v1/tools[/{name}]` as v1 and can onboard a new
client end to end. Every v1 invariant holds per target sub-account: nothing reaches a
person, activates automation, bills anyone or publishes until a human approves it,
and the human can approve the whole run from one page.

## Findings that shape the plan (verified in code, 2026-10-04)

- **Key lookup already spans collections.** `findApiKeyByPrefix`
  (`lib/firestore/api-keys.ts`) is a `collectionGroup("apiKeys")` query backed by the
  `apiKeys.prefix` COLLECTION_GROUP field override in `firestore.indexes.json`. A
  key doc at `agencies/{agencyId}/apiKeys/{keyId}` is found by the same query with
  no new index. Everything after the lookup assumes `subAccountId: string`
  (`ApiAuthContext`, `captureRequestLog`, `reserveIdempotencyKey`, `bucketRef` in
  `enrolment-cap.ts`, `recordAgentWrite`, `createProposal`'s key re-read, the decide
  route's key re-read at `subAccounts/${subAccountId}/apiKeys/${keyId}`, the revoke
  sweep's `subAccountId` filter).
- **Reach needs two gates, not one.** `authenticateApiRequest` refuses unless
  `apiAccessEnabledByAgency === true`; `agentPrecheck` / `dispatchAgentTool` then
  require `agentApiEnabledByAgency === true`. `createSubAccountForAgency`
  (`sub-accounts-service.ts:198-232`) writes `agentApiEnabledByAgency: false` and
  never writes `apiAccessEnabledByAgency` at all. A sub-account "created with the
  agent gate on" is still unreachable unless the API gate is set too.
- **`inSubAccount()` is the wrong seam for an API.** It renames tools
  (`*_in_sub_account`), adds a `subAccountName` arg, resolves a wrong id by fuzzy
  name / account-number match inside the caller's agency, and deliberately drops
  `approval`, `approvalFor`, `agentArgs`, `preview`, `approvalTarget`
  (`capabilities.ts:190-200`). `AGENCY_DELEGATED` is 23 curated names. The tenancy
  checker asserts its re-anchor shape by regex.
- **Everything downstream of dispatch keys on `auth.subAccountId`.** Proposals
  (`subAccountId` is the first component of the proposal id), request logs
  (`subAccounts/{sa}/apiRequestLogs`), idempotency (`subAccounts/{sa}/…` keyed
  `mode_keyId_hash`), the enrolment cap (`subAccounts/{sa}/apiEnrolments/{keyId}_{hour}`,
  per key per sub-account by construction), `agent.write` audit rows, the
  `agentCallable` predicate (`level === "sub-account"`), territory gates. None of
  it reads the key doc again except the key re-checks named above.
- **The onboarding steps mostly exist.** `applySnapshot` (`lib/snapshots/apply.ts`)
  is deterministic-id and retry-safe and writes every workflow `status: "draft"`
  (`apply.ts:399`); there is no capability for it and the route is owner-only.
  `set_workflow_status active` is already `workflow_activate`; `update_booking_page`
  that publishes is already `public_change`; `invite_member` is `surfaces: ["chat"]`
  and calls `createInviteServerSide`; `assign_billing_plan` and
  `create_one_time_charge` (`billing-charges.ts`) are agency-level with **no approval
  class** (dispatch refuses them only because of their level). `create_sub_account`,
  `set_feature_gate`, `list_sub_accounts`, `sub_account_stats`, `list_billing_plans`,
  `create_billing_plan` exist at agency level.
- **No plan is a usable state.** `lib/billing/status.ts:48`: no `billing` doc →
  `comped` → `BillingGuard` never paywalls. `assignPlanToSubAccount` returns
  `pending` + a checkout URL and the workspace sits behind an activation screen
  until the client pays; assigning also re-applies the plan's `PLAN_GATE_KEYS`
  (can switch off gates the agent turned on). `agent-api` is standalone, not a plan
  key, so a plan apply never changes reach.
- **The agency switch pattern exists.** `agencies/{id}.agencyAssistantEnabled` gates
  the Agency Assistant in chat and confirm (`ai-suite/confirm/route.ts:113`).
  `FEATURE_GATES["agent-api"]` (`helpers.ts:245`) carries no `assistantMayEnable:
  false`, so the chat assistant may enable it today; `assistantEnableRefusal` is
  the existing refusal hook, checked in validate and execute.
- **Route inventory.** 221 `route.ts` under the two trees (172 sub-account, 49 agency).
  Covered by agent tools today: pipelines, custom-fields (+folders), products,
  snippets, whatsapp-templates, quotes (create/send/mark-paid), recurring-invoices,
  workflows (+runs), booking-pages, scheduled-messages, social/posts, reputation
  overview + requests, agent-proposals, members (GET), media (GET). Uncovered groups
  are listed under "Grandfathered" below, taken from the real listing.
- **`workflows/[workflowId]/test` sends for real** (v1 PR9 note: a test run reads
  steps live). It is uncovered and must never become a direct tool.
- Lint already runs three zero-dependency source scanners (`check-capability-tenancy`,
  `check-whatsapp-rail`, `lint-cors`) byte-identically in CI and `deploy-velo.sh`;
  `agent-api-doc.test.ts` and `capability-names.test.ts` lock the registry at test time.

## Design decisions

### D1 — dispatch-level targeting, not the wrapper

`dispatchAgentTool` gains an agency branch; the registry is untouched.

```
auth.level === "agency":
  cap.level === "agency"      → ctx = buildAgencyAgentContext(auth)   (no subAccountId)
  cap.level === "sub-account" → target = args.subAccountId (popped before validate)
                                 resolveReach(auth.agencyId, target) → scoped auth
                                 { ...auth, subAccountId: target } → the v1 pipeline unchanged
resolveReach: doc exists ∧ doc.agencyId === auth.agencyId
              ∧ apiAccessEnabledByAgency === true ∧ agentApiEnabledByAgency === true
              else ONE refusal: 404 not_found "No such sub-account is available to this key."
```

`resolveReach` also runs on `args.subAccountId` of every **agency-level** capability
that names one (`apply_snapshot`, `set_sub_account_gate`, `sub_account_stats`,
`assign_billing_plan`, `create_one_time_charge`), so reach is decided in exactly one
place for both kinds. Why targeting: every v1 seam (approval classes, pins,
previews, held enrolments, audit, logs, idempotency, enrolment cap, territory,
`agentCallable`) is keyed on the scoped `subAccountId`, so the whole registry works
per target with zero per-capability work and `capability-names.test.ts` stays
byte-identical for sub-account keys. The wrapper would need all of those seams
re-threaded through 97 generated variants and would carry its fuzzy name resolver
into an API. Cost of targeting: `subAccountId` stops being "from the key doc, never
from the agent's args" (`agent-context.ts` header) — the re-anchor in `resolveReach`
becomes the tenancy boundary and gets its own mutation test. `agentCallable(cap,
level)`: for a sub-account key unchanged; for an agency key, agency-level caps that
declare the `agent` surface are callable too. `tools/list` and `GET /api/v1/tools`
share `agentToolsFor(auth)`: for an agency key every sub-account tool's
`inputSchema` gains `subAccountId` (required; the schemas are
`additionalProperties: false`, hence the pop before validate). A sub-account key
sees exactly the v1 list.

`list_sub_accounts` on the agent surface returns only reachable sub-accounts
(`agentArgs` is not enough — the filter sits in execute on `ctx.apiKey?.level`), so
the list is not an oracle for the 404.

### D2 — key storage: `agencies/{agencyId}/apiKeys/{keyId}`

Same doc shape plus `level: "agency"`, `subAccountId: null`, scopes `["agent"]`
only (mint refuses `admin` / `forms-ingest`). Found by the existing collection-group
lookup; `snapToDoc` tolerates the null. `ApiAuthContext` gains `level:
"agency" | "sub-account"` and `subAccountId: string | null` — `tsc` then lists every
consumer, which is the point. `withApiAuth` refuses `level === "agency"` with 403
`agency_key_not_allowed` unless the route opts in (`allowAgencyKey: true` on the two
tools routes only); `/api/mcp` handles level itself. Auth for an agency key reads
`agencies/{id}.agentApiEnabled === true` (new, default off; the kill switch, in
Agency → Settings beside the Agency Assistant switch) instead of a sub-account gate.
Mint / list / revoke: `GET/POST /api/agency/api-keys`, `DELETE
/api/agency/api-keys/[keyId]` (`requireAgencyOwnerAny`), UI on the same settings
card. Rules: `match /agencies/{agencyId}/apiKeys/{keyId} { allow read, write: if
false; }`.

### D3 — self-escalation

`set_feature_gate` becomes `surfaces: ["chat"]`. New agent-only
`set_sub_account_gate` (level agency) whose **validate** refuses `enabled: true` for
`agent-api` and `api-access` (both halves of reach) and honours
`assistantMayEnable: false` as today; disabling either is allowed (it only narrows
reach). Enabling stays a Manage-dialog click; a `gate_escalation` proposal class is
a possible later addition, not in this phase. `create_sub_account` on the agent
surface (`ctx.apiKey?.level === "agency"`) writes both gates `true` and records the
two gate-change audit rows via `recordGateChanges`, so the escalation is visible in
the new sub-account's audit stream from its first second.

### D4 — approvals: two row kinds, one new page

- **Sub-account-scoped rows** from an agency key (workflow activation, booking
  publish, `invite_member`, every v1 proposal class) are ordinary `agentProposals`
  rows with `subAccountId = target` plus `keyLevel: "agency"`. They land on
  `/sa/[id]/approvals` as today (the sub-account's own members see what the agency's
  agent queued in their workspace) **and** on the agency page.
- **Agency-level rows** (`assign_billing_plan`, `create_one_time_charge`) have
  `subAccountId: null`, `agencyId`, `keyLevel: "agency"`, `targetScoped: false`,
  and a `targetSubAccountId` for display. Id: `p_<sha256("agency:"+agencyId|capability|args)>`.
- `/agency/approvals` (max-w-5xl) lists `agencyId == mine` rows with `subAccountId
  == null || keyLevel == "agency"`, grouped by target sub-account, with **Approve
  all / Reject all** for a group or the page. Batch = a sequential client loop over
  the per-row decide routes (sub-account rows → the existing
  `/api/sub-accounts/[id]/agent-proposals/[proposalId]`, agency rows → new
  `/api/agency/agent-proposals/[proposalId]`), each call carrying that row's `rev`,
  every v1 outcome code rendered per row. No batch endpoint: the per-row claim,
  `rev`, pins, execute deadline and `unsettled` semantics are untouched. The agency
  decide route handles only `subAccountId == null` rows (`requireAgencyOwnerAny`,
  `proposal.agencyId` must match else 404, `roleSatisfies(cap.requiredRole,
  {agencyRoleIsOwner: true})`, re-checks `agencies/{id}.agentApiEnabled`, key
  re-read by `keyLevel`, then the same claim → `executeAndSettle` with an agency
  owner ctx as `ai-suite/confirm` builds it).
- Key re-check everywhere (`createProposal`, both decide routes) goes through one
  `agentKeyRef(row)` that picks `agencies/…` or `subAccounts/…` by `keyLevel`. The
  existing sub-account decide route also re-checks the agency switch when
  `keyLevel === "agency"`.
- Previews: `assign_billing_plan` pins `planId`, price, interval and lists the gates
  the plan apply will switch **off**; `create_one_time_charge` pins amount, currency,
  description; `invite_member` (class `outbound`) pins email + role and execute
  writes the pinned values. `create_billing_plan` creates Stripe objects but bills
  nobody: direct write.

### D5 — the per-key questions

| Concern | Decision |
|---|---|
| Tenancy anchor | `resolveReach` in dispatch; downstream the scoped `ctx.subAccountId` as v1; agency caps anchor on `ctx.agencyId` (checker unchanged, plus `where("agencyId"…)` on `list_sub_accounts`) |
| Cross-agency / gate-off | one 404 body, same as an unknown id; `list_sub_accounts` filtered |
| Rate limit | per key (in-memory by `keyId`), shared across its sub-accounts; v1 numbers (60/min, 1,000/h); the `LIMITS_BY_SCOPE` row is the only dial |
| Enrolment cap | per key **per sub-account** — the bucket is under the target, so each client keeps its own 50/h |
| Idempotency (REST) | per key, agency-wide: `agencies/{id}/apiIdempotency/{mode_keyId_hash}` (the reservation runs before the target is known); the fingerprint covers the body, so the same key with another `subAccountId` is `idempotency_collision`, never a replay into the wrong tenant; the daily api-cleanup sweep covers the new collection |
| Request logs | sub-account-targeted calls → `subAccounts/{target}/apiRequestLogs` (the client's log viewer shows the agency agent); agency-level calls and pre-target refusals → `agencies/{id}/apiRequestLogs` (server-only, no viewer this phase) |
| Audit actor | `{type: "api_key", id: keyId}` as v1; `agent.write` rows under the target sub-account; `create_sub_account` / `apply_snapshot` / gate flips audit under the sub-account they touch, with `keyLevel` in the changes |
| Revoke sweep | `sweepRevokedKeyProposals({keyId, agencyId})`: the `(keyId, status)` index, filter `agencyId`, no `subAccountId` filter — pending rows in every sub-account go `rejected: key_revoked` |
| Kill switch | `agencies/{id}.agentApiEnabled`: checked at auth, in dispatch (fresh), in both decide routes for `keyLevel: "agency"` rows; no sweep, like the sub-account gate |
| Billing plan at creation | none: the new sub-account is `comped` and fully usable; `assign_billing_plan` is a `spend` proposal approved at the end of the run, after which the client sees the activation screen |
| Human-only | no tool for `google/connect`, `meta/connect`, `whatsapp-bridge/*`, `twilio`, `smtp`, `resend`, `*-connection`, `paypal-integration`: manifest exclusions; the agent can at most return the connect URL the app already shows |

## Coverage manifest (the CI gate)

`scripts/agent-coverage.json` maps every route directory (relative to
`src/app/api`) to exactly one of `{tools: [...]}` (non-empty), `{exclude: "<reason,
≥ 20 chars>"}`, or membership of `grandfathered`. `scripts/check-agent-coverage.mjs`
runs in **`pnpm lint`** (zero-dep like its three siblings; the route tree is a
filesystem fact; lint is byte-identical in CI and the deploy script) and fails on: a
`route.ts` not in the manifest, a manifest entry whose route is gone, an exclusion
without a reason, an empty `tools` list, and any `grandfathered` entry not in the
script's own `FROZEN` list (the list can only shrink: removing a route from
`grandfathered` requires it to appear in `routes`, and `FROZEN` is edited in the
same PR, so the diff shows the shrink). `src/lib/api/agent-coverage.test.ts`
(**`pnpm test`**) checks the half that needs the TypeScript registry: every tool
name exists and is `agentCallable` for some key level. A route is never "pending":
unlisted fails. `.github/pull_request_template.md` gains an **Agent exposure** line
("routes added or changed under `src/app/api/sub-accounts/**` or `agency/**`: tool
name(s), or the manifest exclusion and why").

**Grandfathered at A1** (from the real listing; the manifest is the exact per-route
record). Sub-account tree: `agents/watchdog`, `ai-agent/*`, `apexgeo-connection`,
`billing/*`, `branding`, `calendar-feed-url` + `calendar.ics`, `checkout-pages`,
`community/*`, `contacts/[contactId]/*`, `email-suppressions`, `funnels/*`, `gbp/*`,
`get-leads/*`, `google*`, `google-calendar*`, `google-review*`, `import/*`,
`invite` (leaves at A4), `launchpad`, `logs/*`, `mailbox*`, `media` (POST + folders),
`members/[uid]`, `meta*`, `missed-call`, `order-attention`, `payment-links*`,
`payment-mandates`, `paypal-integration`, `paystack-connection`, `prospecting/*`,
`quotes/[quoteId]/{pdf,convert-to-invoice,recheck-card-charge}`, `reports`,
`reputation/{ai-settings,auto-reply,insights,sentiment}`, `resend*`, `smtp*`,
`stripe-connection`, `territories*`, `territory-scoping`, `tracked-links*`, `twilio*`,
`webhook-events`, `webhook-subscriptions*`, `webinar1*`, `website/*`, `whatsapp*`
(connections, senders, profile, status, message-links), `whatsapp-bridge*`,
`workflow-folders*`, `workflows/[workflowId]/test`. Agency tree: `affiliates/*`,
`ai-config`, `ai-kb*`, `ai-models`, `app-icon`, `billing-attention`,
`buyer-map-config`, `deal-config`, `deployment-config`, `email-blocklist`,
`email-purchasers`, `exit-intent-config`, `health`, `messaging-config`,
`plans/[planId]`, `refresh-gitpage-status`, `setup/*`, `snapshots/{import,import-file,shares}`
+ `[snapshotId]/shares*`, `sub-accounts/[id]` (GET/PATCH/DELETE), `sub-accounts/[id]/usage`,
`templates*`, `updates-modal-config` (`sub-accounts/[id]` is PATCH/DELETE only). Already covered or written as exclusions at
A1: `api-keys*` (key management, v1 exclusion), `agent-proposals*` (the queue
itself), the covered groups in the findings, `agency/snapshots` + `apply-snapshot`
+ `sub-accounts` + `feature-gates` + `billing/charges` (tools from A4).

## Module shape

```
src/types/api.ts                              ApiKeyDoc.subAccountId: string | null; level
src/lib/api/auth.ts                           ApiAuthContext.level; agency branch; withApiAuth allowAgencyKey
src/lib/firestore/api-keys.ts                 agency key CRUD; agentKeyRef(row); snapToDoc null-safe
src/lib/api/agent-context.ts                  buildAgencyAgentContext
src/lib/api/agent-dispatch.ts                 agency branch; resolveReach; agentCallable(cap, level)
src/lib/api/agent-tools-listing.ts            agentToolsFor(auth) — shared by REST GET and MCP list (NEW)
src/lib/api/agent-precheck.ts                 by level
src/lib/api/{logs,idempotency}.ts             path by level
src/lib/server/agent-proposals*.ts            keyLevel, agency ids, sweep by agency
src/lib/ai-suite/capabilities/agency.ts       create_sub_account agent path; list_sub_accounts filter
src/lib/ai-suite/capabilities/agency-gates.ts set_sub_account_gate (NEW)
src/lib/ai-suite/capabilities/snapshots.ts    list_snapshots, apply_snapshot (NEW)
src/lib/ai-suite/capabilities/billing-*.ts    approval: "spend" + preview/pins
src/lib/ai-suite/capabilities/members.ts      invite_member → outbound proposal
src/app/api/agency/api-keys/**                mint / list / revoke (NEW)
src/app/api/agency/agent-proposals/**         list + decide (NEW)
src/app/(dashboard)/agency/approvals/page.tsx max-w-5xl (NEW); sidebar entry + badge
src/app/(dashboard)/agency/settings/…         kill switch + keys card
scripts/check-agent-coverage.mjs + scripts/agent-coverage.json   (NEW, in `pnpm lint`)
src/lib/api/agent-coverage.test.ts            tool names exist (NEW, in `pnpm test`)
firestore.rules / firestore.indexes.json      see Firestore changes
```

## PR DAG (each ≤ ~500 lines incl. tests; blind `/review` per PR)

| PR | Depends | Content | `verify:` (failing first) |
|---|---|---|---|
| **A1** coverage gate | — | checker + manifest + `FROZEN` + vitest names test; PR-template line; `agent-api.md` line | checker run against `scripts/__fixtures__/agent-coverage/` trees: a tree with one unlisted `route.ts` → exit 1 naming it; a manifest entry for a missing route → exit 1; `exclude: ""` → exit 1; a `grandfathered` entry outside `FROZEN` → exit 1; the real tree → exit 0. **Mutation:** stub the "unlisted" branch to `continue` → the first fixture goes green, so the fixture test must assert the exit code and the route name in stderr. `agent-coverage.test.ts`: a misspelled tool name → red |
| **A2** agency keys + switch | — | `level` on `ApiKeyDoc` / `ApiAuthContext`; agency CRUD; auth branch on `agencies/{id}.agentApiEnabled`; `withApiAuth` refuses agency keys by default; routes + settings card; rules | `auth.agency-key.test.ts` (memory-firestore): agency key → `/api/v1/contacts` 403 `agency_key_not_allowed`; switch off → 403 `agency_agent_api_disabled`; revoked → 401; mint with `["agent","admin"]` → 400; `snapToDoc` of a null `subAccountId` doc. Rules test: client read of `agencies/a/apiKeys/k` denied for the owner. **Mutation:** remove the `withApiAuth` refusal → the first case goes red |
| **A3** dispatch targeting | A2 | agency branch, `resolveReach`, `agentCallable(cap, level)`, `agentToolsFor`, precheck / logs / idempotency / proposals by level, `agentKeyRef`, revoke sweep by agency, `list_sub_accounts` filter; MCP + REST accept agency keys | `agent-dispatch.agency.test.ts`: sa2 of another agency and sa3 (gate off, same agency) → **byte-identical** 404 body to a random id; sa1 (both gates on) → `find_contacts` returns sa1 rows only; `send_message` → row `subAccountId = sa1`, `keyLevel: "agency"`; existing decide route approves it, execute spy once, key read from `agencies/…`; revoke the agency key → pending rows in sa1 **and** sa4 → `rejected`; switch off → dispatch 403 and approve 403; `tools/list`: agency key → every sub-account tool requires `subAccountId`, sub-account key → the v1 set exactly; `apply_snapshot` args naming sa3 → 404. **Mutation:** stub the `doc.agencyId === auth.agencyId` compare → the sa2 case goes red |
| **A4** onboarding tools | A3 | `create_sub_account` agent path (both gates + audit rows); `set_sub_account_gate`; `set_feature_gate` chat-only; `list_snapshots` / `apply_snapshot`; `invite_member` → `outbound`; `assign_billing_plan` + `create_one_time_charge` → `spend` with previews / pins; `capability-names.test.ts` updated on purpose; tools doc regenerated | `agency-onboarding.test.ts`: via agency key `create_sub_account` → both gates `true` + two gate audit rows; via chat ctx → both unchanged; `set_sub_account_gate agent-api true` and `api-access true` → refused in **validate** (mutation: drop the refusal → red); `… whatsapp true` → written; `apply_snapshot` → every workflow `draft`, forms / products / fields counted; `assign_billing_plan` → proposal, `assignPlanToSubAccount` spy 0, preview lists the gates the plan would switch off; `invite_member` → proposal, SMTP spy 0; approve → `createInviteServerSide` called once with the pinned email. `outbound-never-sends.test.ts` extended to iterate agency-callable caps |
| **A5** agency approvals page | A3, A4 | list + decide routes; `/agency/approvals`; sidebar entry + badge; Approve all / Reject all loop; `canSeeProposal` agency branch; index | `agency decide/route.test.ts`: owner of another agency → 404; a sub-account row on the agency route → 404; two concurrent approves → execute once, one 200 + one 409; switch off → 403. Rules test: agency-level row readable by its owner, not by sa members, not by another owner. `e2e/specs/agency-approvals.spec.ts`: seed one agency `spend` row + a `hard_delete` row + an email `send_message` row on the fixture tenant (no SMTP) → Approve all → three outcomes rendered (`executed`, `executed`, `failed` with the seam's refusal), as v1 PR6 proved outcomes |
| **A6** docs + live validation | A1–A5 | `agent-api.md` agency section, `agent-api-tools.md`, `firestore-collections.md`, `feature-gates.md` (the switch), status flip | live checklist below |
| **B1…Bn** burn-down | A1 | one group per PR, see below | each PR moves its group out of `grandfathered` and `FROZEN`; the manifest diff is the proof |

## Burn-down order (outline only)

Tentative call per group; "expose" means tools with the v1 classes, "exclude" means
a written manifest reason.

1. **Expose, no outbound:** `workflow-folders`, `members/[uid]` (role change W,
   remove `hard_delete`), `media` (folders W; upload needs a URL source: exclude),
   `territories` + `territory-scoping`, `tracked-links`, `reports`,
   `quotes/[quoteId]/pdf` (R), `agency/sub-accounts/[id]` (PATCH rename / timezone W;
   DELETE `hard_delete`), `agency/plans/[planId]` (edit W, archive `hard_delete`),
   `agency/templates`, `logs/*` (R), `launchpad` (R), `order-attention` (R),
   `billing-attention` (R), `usage` (R).
2. **Expose with a class:** `reputation/{ai-settings,auto-reply}` (auto-reply on =
   `public_change`), `email-suppressions` (`channel_change`), `missed-call`
   (`outbound`: it texts callers), `quotes/convert-to-invoice` (`spend`),
   `recheck-card-charge` (`spend`), `payment-links` (`spend`), `checkout-pages`
   (`public_change`), `funnels` (`public_change` on publish), `webhook-events/redeliver`
   (`outbound`), `prospecting` (`outbound` for report share), `get-leads` (import
   W; search R with the quota noted), `community` (publish `public_change`; the
   builders stay chat-only), `webinar1/register` (`outbound`), `agency/snapshots/*`
   capture + import + shares (share = `public_change`), `agency/*-config` (W: brand
   copy — flag for Hein), `ai-agent/{profile,channels}` (channel enable = `spend`).
3. **Exclude, human-only (ruling 3):** every connection route (`google*`, `meta*`,
   `whatsapp*`, `whatsapp-bridge*`, `twilio*`, `smtp*`, `resend*`, `stripe-connection`,
   `paystack-connection`, `paypal-integration`, `apexgeo-connection`, `import/ghl/connect`),
   `billing/{checkout,portal}` (Stripe-hosted), `payment-mandates/revoke` (money),
   `setup/*` (deployment env), `website/*` and `agency/refresh-gitpage-status` (chat-only
   builder), `workflows/[workflowId]/test` (sends for real with no proposal seam),
   `calendar.ics` + `calendar-feed-url` (secret URLs), `gbp/*` (reply posting is a
   separate programme; reads via `list_reviews`), `agents/watchdog`, `affiliates/*`,
   `email-purchasers`, `health`, `ai-models`, `contacts/[contactId]/notes/mention-tasks`
   (internal), `import/jobs/*` (chunked upload).

## Firestore changes

- `firestore.rules`: `agencies/{id}/apiKeys`, `apiIdempotency`, `apiRequestLogs` →
  `allow read, write: if false`; `canSeeProposal` gains `(p.get("subAccountId",
  null) == null && isAgencyOwner(p.agencyId))`.
- `firestore.indexes.json`: `agentProposals (agencyId ASC, status ASC, createdAt DESC)`
  for the agency list. The revoke sweep reuses `(keyId, status)`.
- Rules and indexes deploy separately from the app: `firebase deploy --only
  firestore:rules,firestore:indexes` after A2 (rules) and again after A5 (rules +
  index), from `main`, after checking no other open PR carries rules changes
  (`feedback_rules_deploy_check_then_deploy`). A missing index surfaces at runtime
  as `FAILED_PRECONDITION` on the agency page, not in CI.

## Live validation (after A6, prod, agency CrestaHQ, no real contacts, no outbound to real people)

1. Owner switches on `agentApiEnabled` in Agency → Settings; mints an agency key.
   `claude mcp add --transport http leadstack-agency https://crm.crestahq.com/api/mcp
   --header "Authorization: Bearer lsk_live_…"`.
2. `list_sub_accounts` shows only gate-on sub-accounts (#1000). `find_contacts` with
   a real client's id whose gate is off → the 404; with a made-up id → the same bytes.
3. `create_sub_account "Agency agent smoke <ts>"` → appears under Agency →
   Sub-accounts with Agent API **and** API access ticked; audit stream shows both.
4. `apply_snapshot` (an existing agency snapshot) → counts; workflows all draft.
   `create_pipeline`, `create_custom_field`, `create_product`, `create_snippet`,
   `create_workflow` (draft), `create_booking_page` (draft),
   `set_sub_account_gate whatsapp true` → all direct. `set_sub_account_gate
   agent-api true` → refused; `api-access false` → written, next call → 404 (reach
   lost by design); owner re-ticks it in the Manage dialog.
5. Proposals: `set_workflow_status active`, `update_booking_page status published`,
   `invite_member` (Hein's own address, role collaborator), `assign_billing_plan`
   (a test plan) → four rows. `/agency/approvals` shows them grouped under the
   smoke sub-account; **Approve all** → outcomes per row; the sub-account's own
   `/sa/<id>/approvals` shows the same rows decided. Reject the plan if the Stripe
   mode on prod would send a checkout link anywhere but the screen.
6. REST: `POST /api/v1/tools/find_contacts` with `{subAccountId}` → 200; without →
   400; with a v1 sub-account key and a `subAccountId` → the v1 behaviour (ignored
   arg refused by `additionalProperties`).
7. Revoke the key → any remaining pending rows `rejected: key_revoked`; switch off
   `agentApiEnabled`; delete the smoke sub-account from the agency UI. Screenshots
   redacted before commit.

## Open risks

- **Highest risk: `resolveReach` is the whole tenancy boundary** for a key that
  reaches every gated client of an agency — one `agencyId` compare and two gate
  reads; a regression there is a cross-client leak at agency scale, which is why it
  has a dedicated mutation test and is the only place that reads a target.
- **Strongest argument against the design:** one agency key is a skeleton key — a
  prompt-injected agent (every contact message it reads is untrusted input) can
  enumerate and edit every gated client workspace, where v1 keys bounded the blast
  radius to one client; the per-sub-account gate, proposals for anything outbound
  and the kill switch shrink that, they do not remove it.
- `subAccountId: string | null` ripples through every `ApiAuthContext` consumer;
  the compiler lists them, the default refusal in `withApiAuth` fails closed, but
  a consumer that stringifies the null (a log path `subAccounts/null/…`) would not
  be a type error — A3's test asserts no `subAccounts/null` path is written.
- `set_feature_gate` leaves the chat-only path; the Agency Assistant's prompt and
  the `FEATURE_GATES`-driven enum stay as they are, the names lock table changes once.
- Plan apply after an onboarding run can switch off gates the agent enabled; the
  preview says which, and nothing else re-applies gates.
- Rate limit is per process and per key; a buyer onboarding many clients from one
  key in parallel hits 1,000/h first. One row in `LIMITS_BY_SCOPE` if it happens.
- Agency-level request logs have no viewer in this phase.
- The `invite_member` approval sends a real email to the invited address on approve;
  the live check invites only the owner.
