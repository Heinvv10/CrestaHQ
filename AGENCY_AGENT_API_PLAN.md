# Agency Agent API (Agent API phase 2)

> Status: **PLAN, rev 2 (2026-10-04, after blind review round 1: REJECT → revised)**.
> Builds on the live v1 ([AGENT_API_V1_PLAN.md](AGENT_API_V1_PLAN.md),
> [docs/features/agent-api.md](docs/features/agent-api.md)).
> Owner rulings locked (Hein, 2026-10-04): one **agency-wide key** minted by the
> agency owner, every call names a `subAccountId`; the key reaches only sub-accounts
> with `agentApiEnabledByAgency` on, everything else is the same 404 as a nonexistent
> id; a sub-account the key creates starts with the gate on; revoke or the agency
> kill switch cuts off everything; **end-to-end onboarding by an agent is the
> headline**: create, snapshot, pipelines / fields / products / snippets, draft
> workflows and booking pages run directly; billing plans, charges, member invites,
> workflow activation and booking-page publish are proposals on a **new agency
> approvals page** that batches a run; OAuth / QR / credentials stay human-only; a
> **CI-enforced manifest** maps every route to tools or a written exclusion, with a
> grandfathered list that can only shrink. **Amended 2026-10-04 (review P0-3):**
> direct gate changes only on sub-accounts this key created and only for gates with
> no outbound or destructive effect; on an existing sub-account any enable that can
> start messages, spend or AI replies, and any destructive disable, is a proposal;
> `agent-api` and `api-access` are never enabled by the key, only proposed to the
> agency owner. Order: coverage gate → keys + onboarding + approvals page → burn-down.

## Goal

An agent holding one `lsk_live_…` key minted at `agencies/{agencyId}/apiKeys` calls
the same `POST /api/mcp` and `/api/v1/tools[/{name}]` as v1 and can onboard a new
client end to end. Every v1 invariant holds per target sub-account: nothing reaches a
person, activates automation, bills anyone or publishes until a human approves it,
and the human can approve the whole run from one page.

## Findings that shape the plan (verified in code, 2026-10-04)

- **Key lookup already spans collections.** `findApiKeyByPrefix`
  (`lib/firestore/api-keys.ts:234-245`) is a `collectionGroup("apiKeys")` query
  backed by the `apiKeys.prefix` COLLECTION_GROUP field override
  (`firestore.indexes.json:1076`). A doc at `agencies/{agencyId}/apiKeys/{keyId}` is
  found with no new index; `snapToDoc` keeps data fields only, not the path.
- **Every key re-read assumes a sub-account path.** `createProposal`
  (`agent-proposals.ts:109`), the decide route (`[proposalId]/route.ts`), the
  enrolment replay (`agent-enrolment-replay.ts:97`, silently defaulting the cap to
  50 when the doc is missing), `bumpApiKeyLastUsed(candidate.subAccountId, …)`
  (`auth.ts:271`), the revoke hook signature `{subAccountId, keyId}`
  (`api-keys.ts:182-218`), `agentActor` (`helpers.ts:290-297`, no level, so a held
  enrolment from an agency key would be refused as `key_revoked` by `createProposal`
  and land as `hold_refused`), and the `apiKey` `Pick` in `capabilities/types.ts:67-70`.
- **Reach needs two gates.** `authenticateApiRequest` requires
  `apiAccessEnabledByAgency === true`; precheck and dispatch require
  `agentApiEnabledByAgency === true`. `createSubAccountForAgency`
  (`sub-accounts-service.ts:198-232`) writes `agentApiEnabledByAgency: false` and
  never writes `apiAccessEnabledByAgency`. `agentPrecheck` reads
  `subAccounts/${ctx.subAccountId}` (`agent-precheck.ts:19`), so an agency key fails
  closed today only by reading `subAccounts/null`.
- **Surfaces default open.** `availableOn` treats a capability with no `surfaces`
  as available on every surface (`capabilities.ts:365-370`); all 8 agency-level caps
  have none, and `inSubAccount` copies `base.surfaces` (`capabilities.ts:188`) while
  dropping `approval` / `approvalFor` / `agentArgs` / `preview` (`:189-190`). Only
  `level === "sub-account"` in `agentCallable` keeps them off the agent surface.
  `FEATURE_GATES["agent-api"]` has no `assistantMayEnable: false` (`helpers.ts:245`).
- **`create_sub_account` writes the caller as admin member**: `agency.ts:286` passes
  `uid: ctx.uid`, and the service writes `subAccountMembers/{uid}` +
  `userMemberships/{uid}` (`sub-accounts-service.ts:248-268`). On the agent surface
  that uid is `apikey:<prefix>`: a phantom member and no switcher entry for the owner.
- **Plans change reach.** `apiAccessEnabledByAgency` and `emailDomainEnabledByAgency`
  are `PLAN_GATE_KEYS` (`types/billing.ts:25-26`); `assignPlanToSubAccount` applies
  `plan.gates` in both directions (`billing-service.ts:621`), and on a live
  subscription switches it immediately with proration (`:542-548`); only a
  sub-account with no subscription gets the activation screen. No `billing` doc is
  `comped` and never paywalled (`billing/status.ts:48`).
- **Onboarding seams.** `applySnapshot` is deterministic-id and retry-safe, writes
  workflows `draft` (`apply.ts:399`), creates forms with `submissionCount: 0`
  (`:316-328`) and writes the customer-facing AI persona when none is set
  (`:149-174`). `set_workflow_status active` is `workflow_activate`; a publishing
  `update_booking_page` is `public_change`; `invite_member` is chat-only and also
  re-roles an existing member or adds a verified user with nothing to accept
  (`members.ts:79`); `assign_billing_plan` / `create_one_time_charge` have no
  approval class (`billing-charges.ts:15,151`).
- **Teardown is not free.** `deleteSubAccountForAgency` refuses while `forms`,
  `products`, `contacts`, … exist (`sub-accounts-service.ts:55-68`) and
  `recursiveDelete` covers only the sub-account doc's subtree (`:150-152`):
  top-level `workflows` / `bookingPages` would be orphaned.
- **Validators drop unknown keys** (`str()` in `helpers.ts:18-21`; no JSON-Schema
  validation in `agent-mcp.ts` or dispatch), so a v1 key sending `subAccountId` is
  ignored, not refused.
- **Route inventory.** 221 `route.ts` under `sub-accounts/**` + `agency/**`
  (172 / 49), but tenant routes also live under `api/{community,events,comms,
  contacts,deals,tasks,quotes,broadcasts,workflows,forms,automations,
  scheduled-messages,social,…}` and outside `api/` (`src/app/{l,pay,rr,report}/**`,
  including a `route.tsx`). `members/route.ts` exports `GET` only; `sub-accounts/[id]`
  is `PATCH` + `DELETE`. The Agency Assistant switch is written by `PATCH /api/agency`
  (`agency/route.ts:198-205`) from `agency-assistant-section.tsx`.
- `workflows/[workflowId]/test` sends for real (v1 PR9 note). `list_sub_accounts`
  applies `.limit(50)` before any filter (`agency.ts:36`). The daily api-cleanup
  sweeps idempotency by collection group (`cron/api-cleanup/route.ts:99`), so a new
  `agencies/*/apiIdempotency` path is covered.
- Lint runs three zero-dependency scanners byte-identically in CI and `deploy-velo.sh`.

## Design decisions

### D1 — dispatch-level targeting, not the wrapper

```
auth.level === "agency":
  cap in AGENCY_AGENT_CALLABLE (cap.level === "agency")  → ctx = buildAgencyAgentContext(auth)
  cap.level === "sub-account"                            → target = args.subAccountId (popped before validate)
  any args.subAccountId, either kind                     → resolveReach(auth.agencyId, target)
resolveReach: doc exists ∧ doc.agencyId === auth.agencyId
              ∧ apiAccessEnabledByAgency === true ∧ agentApiEnabledByAgency === true
              else ONE refusal: 404 not_found "No such sub-account is available to this key."
sub-account cap after reach: scoped auth { ...auth, subAccountId: target } → the v1 pipeline unchanged
```

Why targeting: every v1 seam (approval classes, pins, previews, held enrolments,
audit, logs, idempotency, enrolment cap, territory) keys on the scoped
`subAccountId`, so the registry works per target with no per-capability work, and
`capability-names.test.ts` stays byte-identical for sub-account keys. The wrapper
renames tools, fuzzy-resolves ids by name and drops the approval fields by design.
Cost: `subAccountId` stops being "from the key doc" — `resolveReach` becomes the
tenancy boundary and gets its own mutation test.

**REVISED 2026-10-04 (P0-1):** agency-level callability is an explicit named set
`AGENCY_AGENT_CALLABLE` in `agent-dispatch.ts`, never derived from `availableOn`.
A3a ships it as `{list_sub_accounts, sub_account_stats}`; every later capability
joins in the PR that gives it its approval class. `agent-callable-set.test.ts`
asserts the agency-callable set computed from the registry equals the named set
exactly; mutation: adding `set_feature_gate` to the set turns it red.
**REVISED 2026-10-04 (P0-2):** `inSubAccount` sets `surfaces: ["chat"]` and
`agentCallable` refuses any `*_in_sub_account` name on both levels; `resolveReach`
runs on any `subAccountId` argument of any agency-level call, not a hand-kept list;
A3a iterates the registry to prove it. **REVISED (P2):** a sub-account key sending a
`subAccountId` that differs from its own → 400 `wrong_sub_account` (validators would
otherwise drop it silently).

`agentToolsFor(auth)` (shared by REST GET and MCP list): for an agency key every
sub-account tool's `inputSchema` gains `subAccountId` (required). `list_sub_accounts`
on the agent surface filters to reachable sub-accounts **before** applying the row
cap (REVISED, P2: the chat `.limit(50)` runs first today).

### D2 — key storage: `agencies/{agencyId}/apiKeys/{keyId}`

Same doc shape, scopes `["agent"]` only, live mode only (mint refuses `admin`,
`forms-ingest` and `mode: "test"` — REVISED, P2). **REVISED (P2):** level and
agency are derived from the doc **path** in `findApiKeyByPrefix`, not from data
fields. `ApiAuthContext` gains `level` and `subAccountId: string | null`;
`ctx.apiKey` carries `level`. `withApiAuth` refuses `level === "agency"` with 403
`agency_key_not_allowed` unless the route opts in (`allowAgencyKey`). **REVISED
(P1-6):** in A2 `/api/mcp` and the tools routes refuse agency keys too, logging to
`agencies/{id}/apiRequestLogs`; transports accept agency keys only at the end of
A3b. Auth reads the kill switch `agencies/{id}.agentApiEnabled === true` (new,
default off, written by `PATCH /api/agency` beside `agencyAssistantEnabled` and
shown in `agency-assistant-section.tsx`'s card — REVISED, P2: not Settings).
`bumpApiKeyLastUsed` and the revoke hook take a key ref, not a sub-account id. A2
asserts no write ever lands under `subAccounts/null`. Rules: deny-all on
`agencies/{id}/{apiKeys,apiIdempotency,apiRequestLogs}` (no separate rules test:
the default deny at `firestore.rules:1608` already covers it — REVISED, P2).

### D3 — gates and self-escalation (REVISED 2026-10-04, P0-3 + owner amendment)

`set_feature_gate` becomes `surfaces: ["chat"]` and `FEATURE_GATES["agent-api"]` /
`["api-access"]` gain `assistantMayEnable: false` (closes the chat path too). New
agent-only `set_sub_account_gate` (agency level, in `AGENCY_AGENT_CALLABLE` from A4a):

- **Direct** only when the target's `createdByKeyId === auth.keyId` **and** the gate
  is in `DIRECT_GATES` = gates with no outbound, spend or destructive effect
  (`labs`, `community`, `website`, `social-planner`, `prospecting`, `get-leads`,
  `google-calendar`, `webinar1`, `payments` enable; `missed-call-text-back`,
  `broadcasts`, `outbound-voice`, `sms-agent`, `web-chat`, `inbound-voice`,
  `whatsapp`, `meta-inbox`, `meta-agent`, `reviews-ai`, `reviews-auto-reply`,
  `email-domain`, `google` are **never** direct: they start replies, spend or tear
  down).
- Everything else is a `gate_change` proposal (new class; agency-level row, the
  preview names the gate, direction and the documented side effect from
  `feature-gates.md`); `agent-api` and `api-access` enables are always proposals,
  approved only by the agency owner on `/agency/approvals`.
- `create_sub_account` on the agent surface writes both reach gates `true`,
  records the two gate audit rows, stamps `createdByKeyId`, and (REVISED, P1-3)
  writes the membership docs for the **owner who minted the key**
  (`key.createdByUid`), never `apikey:<prefix>`; per key: 10 creations per UTC day
  and a dedupe on `(keyId, name)` within 10 minutes (MCP has no idempotency).
- `apply_snapshot` is direct only on key-created targets; on any other sub-account
  it is a `public_change` proposal (REVISED, P1-10: it writes the AI persona when
  absent and creates forms).

### D4 — approvals: two row kinds, one new page

- **Sub-account-scoped rows** from an agency key are ordinary `agentProposals` rows
  with `subAccountId = target` plus `keyLevel: "agency"`; they land on
  `/sa/[id]/approvals` as today **and** on the agency page.
- **Agency-level rows** (`assign_billing_plan`, `create_one_time_charge`,
  `gate_change`) have `subAccountId: null`, `agencyId`, `keyLevel: "agency"`,
  `targetScoped: false`, `targetSubAccountId` for display; id
  `p_<sha256("agency:"+agencyId|capability|args)>`.
- `/agency/approvals` (max-w-5xl) lists `agencyId == mine ∧ keyLevel == "agency"`
  (index `(agencyId, keyLevel, status, createdAt DESC)` — REVISED, P2), grouped by
  target sub-account. **REVISED (P1-8):** "Approve all" covers only
  `workflow_activate`, `public_change`, `workflow_enrolment`, `channel_change` and
  `gate_change`; `outbound`, `spend` and `hard_delete` rows are approved one by one,
  and the button shows counts per class first. Batch = a sequential client loop over
  the per-row decide routes (sub-account rows → the existing
  `/api/sub-accounts/[id]/agent-proposals/[proposalId]`, agency rows → new
  `/api/agency/agent-proposals/[proposalId]`: `requireAgencyOwnerAny`, agency match
  else 404, `roleSatisfies(…, {agencyRoleIsOwner: true})`, kill switch re-check,
  then the same claim → `executeAndSettle`). No batch endpoint: claim, `rev`, pins,
  deadline and `unsettled` are untouched.
- One `agentKeyRef(row)` (by `keyLevel`) serves `createProposal`, both decide
  routes, the enrolment replay and `agentActor` (REVISED, P1-1).
- Previews: `assign_billing_plan` pins `planId`, price, interval and shows **every
  gate going on and off**, flags `api-access` and `email-domain`, and says
  "switches the live subscription now, prorated" when one exists (REVISED, P1-4);
  `create_one_time_charge` pins amount, currency, description; `invite_member`
  (`outbound`) pins email + role and shows "existing member: role X → Y" or "added
  immediately, nothing to accept" (REVISED, P1-8). `create_billing_plan` bills
  nobody: direct, joins the set in A4b.

### D5 — the per-key questions

| Concern | Decision |
|---|---|
| Tenancy anchor | `resolveReach` in dispatch for every `subAccountId`; downstream the scoped `ctx.subAccountId`; agency caps anchor on `ctx.agencyId` |
| Cross-agency / gate-off | one 404 body (compared minus `request_id`); fixtures for gate-off in each direction; `list_sub_accounts` filtered |
| Rate limit | per key, v1 numbers; `LIMITS_BY_SCOPE.agent` is shared with sub-account agent keys, so an agency-only dial means a new row (REVISED, P2) |
| Enrolment cap | per key **per sub-account** (bucket under the target); replay reads the cap via `agentKeyRef` |
| Idempotency (REST) | per key, `agencies/{id}/apiIdempotency/{mode_keyId_hash}`; body in the fingerprint, so another `subAccountId` = `idempotency_collision`; **REVISED (P2):** `precheck` receives the parsed body and runs `resolveReach` on `body.subAccountId` before the idempotency lookup, so a cached reply never outlives a gate switch |
| Request logs | **REVISED (P1-7):** logged under `subAccounts/{target}` only after `resolveReach` succeeds; every refusal and agency-level call → `agencies/{id}/apiRequestLogs` (no viewer this phase); test: a refused call writes nothing under any sub-account |
| Audit actor | `{type: "api_key", id: keyId}` + `keyLevel`; `agent.write` under the target; creation / snapshot / gate flips under the sub-account they touch |
| Revoke sweep | `sweepRevokedKeyProposals({keyRef, agencyId})` on the `(keyId, status)` index, no sub-account filter |
| Kill switch | `agencies/{id}.agentApiEnabled`: auth, dispatch (fresh), both decide routes for `keyLevel: "agency"` rows |
| Billing plan at creation | none: `comped`, fully usable; `assign_billing_plan` is a `spend` proposal approved last |
| Human-only | no tool for any connection route, credentials, `billing/{checkout,portal}`, `PATCH /api/agency` (the switch itself) |
| Out of scope, recorded | key expiry / rotation; a run id across one onboarding; a viewer for agency logs; an agent that reads client B and writes to A is bounded only by reach + audit (POPIA: both clients are the agency's own tenants) |

## Coverage manifest (the CI gate) — REVISED 2026-10-04 (P1-2)

`scripts/agent-coverage.json` keys every **`path:METHOD`** (methods parsed from
`export (async function|const) (GET|POST|PUT|PATCH|DELETE)`) of every
`src/app/**/route.{ts,tsx,js,mjs}` to exactly one of `{tools: [...]}` (non-empty),
`{exclude: {category, reason}}` with `category ∈ {human-only, chat-only,
internal, public-unauth, key-management, queue-itself}`, or membership of
`grandfathered` (exact entries, no globs). Every top-level tree
(`api/community`, `api/events`, `api/comms`, `pay/`, `report/`, …) must itself be
listed as in scope or excluded with a reason; a new tree fails.
`scripts/check-agent-coverage.mjs` runs in **`pnpm lint`** (zero-dep, byte-identical
in CI and the deploy script) and fails on: an unlisted `path:METHOD`, an entry whose
route is gone, an exclusion without category + reason, an empty `tools`, and a
`grandfathered` entry not in the script's `FROZEN` list. **The shrink rule is
review-enforced, not machine-enforced:** `FROZEN` lives in the same script and a PR
can extend it; the diff shows it, and the PR-template line asks the reviewer to
refuse any addition. `src/lib/api/agent-coverage.test.ts` (**`pnpm test`**) checks
that every tool name exists and is callable for some key level. A route is never
"pending". `.github/pull_request_template.md` gains an **Agent exposure** line
("every route added or changed: tool name(s), or the manifest exclusion and why;
`FROZEN` never grows").

**Grandfathered at A1** (group level; the manifest is the per-method record).
Sub-account tree: `agents/watchdog`, `ai-agent/*`, `apexgeo-connection`, `billing/*`,
`branding`, `calendar-feed-url` + `calendar.ics`, `checkout-pages`, `community/*`,
`contacts/[contactId]/*`, `email-suppressions`, `funnels/*`, `gbp/*`, `get-leads/*`,
`google*`, `google-calendar*`, `google-review*`, `import/*`, `invite` (leaves at A4b),
`launchpad`, `logs/*`, `mailbox*`, `media` POST + folders, `members/[uid]`, `meta*`,
`missed-call`, `order-attention`, `payment-links*`, `payment-mandates`,
`paypal-integration`, `paystack-connection`, `prospecting/*`,
`quotes/[quoteId]/{pdf,convert-to-invoice,recheck-card-charge}`, `reports`,
`reputation/{ai-settings,auto-reply,insights,sentiment}`, `resend*`, `smtp*`,
`stripe-connection`, `territories*`, `territory-scoping`, `tracked-links*`, `twilio*`,
`webhook-events`, `webhook-subscriptions*`, `webinar1*`, `website/*`, `whatsapp*`,
`whatsapp-bridge*`, `workflow-folders*`, `workflows/[workflowId]/test`. Agency tree:
`affiliates/*`, `ai-config`, `ai-kb*`, `ai-models`, `app-icon`, `billing-attention`,
`buyer-map-config`, `deal-config`, `deployment-config`, `email-blocklist`,
`email-purchasers`, `exit-intent-config`, `health`, `messaging-config`,
`plans/[planId]`, `refresh-gitpage-status`, `setup/*`, `snapshots/{import,import-file,shares}`
+ `[snapshotId]/shares*`, `sub-accounts/[id]` (PATCH, DELETE), `sub-accounts/[id]/usage`,
`templates*`, `updates-modal-config`. The other trees (`api/community`, `events`,
`comms`, `contacts`, `deals`, `tasks`, `quotes`, `broadcasts`, `workflows`, `forms`,
`automations`, `scheduled-messages`, `social`, `pay`, `report`, `l`, `rr`, …) are
grandfathered whole at A1 and classified in the burn-down. Exclusions at A1:
`api-keys*` (key-management), `agent-proposals*` (queue-itself: no tool exists for
the queue), `PATCH /api/agency` (human-only), inbound `webhooks/*` (public-unauth).

## Module shape

```
src/types/api.ts, src/lib/api/auth.ts         level + subAccountId | null; agency auth branch; withApiAuth allowAgencyKey; precheck(ctx, body)
src/lib/firestore/api-keys.ts                 agency key CRUD; agentKeyRef(row); level from path; bump / revoke by ref
src/lib/api/agent-dispatch.ts                 AGENCY_AGENT_CALLABLE; resolveReach; agency branch; wrong_sub_account
src/lib/api/agent-tools-listing.ts (NEW)      agentToolsFor(auth); agent-context / precheck / logs / idempotency by level
src/lib/server/agent-proposals*.ts, agent-enrolment-replay.ts   keyLevel, agency ids, gate_change, sweep + cap via agentKeyRef
src/lib/ai-suite/capabilities/…               helpers (agentActor level, assistantMayEnable), agency, agency-gates (NEW),
                                              snapshots (NEW), billing-*, members
src/lib/server/sub-accounts-service.ts        createdByKeyId, owner membership on the agent path, creation cap
src/app/api/agency/{api-keys,agent-proposals}/** (NEW); agency/route.ts + agency-assistant-section.tsx (switch + keys card)
src/app/(dashboard)/agency/approvals/page.tsx + sidebar (NEW)
scripts/check-agent-coverage.mjs + agent-coverage.json; src/lib/api/agent-coverage.test.ts; scripts/teardown-smoke-sub-account.mjs
firestore.rules / firestore.indexes.json
```

## PR DAG (REVISED 2026-10-04: A3 and A4 split; each ≤ ~500 lines incl. tests; blind `/review` per PR)

| PR | Depends | Content | `verify:` (failing first) |
|---|---|---|---|
| **A1** coverage gate | — | checker (all `src/app/**/route.*`, per method, tree list, exact `FROZEN`) + manifest + names test; PR-template line | checker against `scripts/__fixtures__/agent-coverage/`: an unlisted `path:POST` → exit 1 naming it; a listed route that is gone → 1; `exclude` without category → 1; a `grandfathered` glob or an entry outside `FROZEN` → 1; a new top-level tree → 1; the real tree → 0. **Mutation:** stub the unlisted branch → the first fixture goes green, so the test asserts exit code + the `path:METHOD` in stderr. Names test: a misspelled tool → red |
| **A2** agency keys + switch | — | `level` from the doc path; agency CRUD; auth branch on `agentApiEnabled`; `withApiAuth`, `/api/mcp` and the tools routes refuse agency keys; bump / revoke by key ref; routes + card | `auth.agency-key.test.ts`: agency key → `/api/v1/contacts` 403 `agency_key_not_allowed`; → `/api/mcp` 403, row under `agencies/{id}/apiRequestLogs`; switch off → 403; revoked → 401; mint `["agent","admin"]` or `mode:"test"` → 400; after every case no doc under `subAccounts/null`. **Mutation:** drop the `withApiAuth` refusal → red |
| **A3a** reach + listing | A2 | `resolveReach` (generic on any `subAccountId`), `AGENCY_AGENT_CALLABLE = {list_sub_accounts, sub_account_stats}`, variants chat-only + refused by name, `agentToolsFor`, logs / idempotency by level, `precheck(ctx, body)`, `wrong_sub_account`; transports still refuse agency keys | `agent-dispatch.agency.test.ts`: sa2 (other agency), sa3 (agent-api off), sa5 (api-access off) → identical 404 minus `request_id`; sa1 → `find_contacts` rows of sa1 only; a refused call writes no log under any sub-account; `agent-callable-set.test.ts` = named set exactly, no `*_in_sub_account` callable (iterates the registry); a sub-account key with another `subAccountId` → 400. **Mutations:** stub the `agencyId` compare → sa2 goes red; add `set_feature_gate` to the set → red |
| **A3b** keyLevel threading | A3a | `agentKeyRef` in `createProposal`, both decide routes, enrolment replay, `agentActor`, revoke hook + sweep; `keyLevel` on rows; transports accept agency keys | agency-key `create_contact` matching an ACTIVE workflow → one `workflow_enrolment` row with `keyLevel: "agency"`, no hold failure; approve via the existing decide route → execute once, cap reserved from the agency key doc; revoke → pending rows in sa1 **and** sa4 → `rejected`; switch off → dispatch 403 and approve 403; MCP `tools/list` for an agency key requires `subAccountId` on every sub-account tool, a sub-account key sees the v1 set exactly |
| **A4a** create + gates + snapshot | A3b | `create_sub_account` agent path (both gates, owner membership, `createdByKeyId`, cap, dedupe); `set_sub_account_gate` + `DIRECT_GATES` + `gate_change`; `set_feature_gate` chat-only + `assistantMayEnable`; `list_snapshots` / `apply_snapshot` | via agency key: both gates `true`, member doc = owner uid, no `apikey:` member, 11th creation that day → refused, same name within 10 min → same id; via chat: unchanged. Gates: `labs true` on a key-created target → written; `whatsapp true` anywhere → `gate_change` proposal; `agent-api true` → proposal only; `google false` on an existing target → proposal; `labs true` on a non-key-created target → proposal (mutation: drop the `createdByKeyId` check → red). `apply_snapshot` on key-created → direct, workflows `draft`; elsewhere → `public_change` proposal |
| **A5** agency approvals page | A3b | list + decide routes; `/agency/approvals`; sidebar + badge; class-limited Approve all; `canSeeProposal` branch; index | decide route: other agency's owner → 404; a sub-account row → 404; two concurrent approves → execute once, 200 + 409; switch off → 403. Rules test: agency row readable by its owner, not by sa members or another owner (mutation: drop the branch → red). `e2e/specs/agency-approvals.spec.ts`: seed a `hard_delete`, an email `send_message` (no SMTP) and a `gate_change` row → Approve all approves only the gate row and shows "2 need individual approval"; approving the others one by one → `executed` / `failed` with the seam's refusal |
| **A4b** invite + billing | A4a, A5 | `invite_member` → `outbound` with the existing-member preview; `assign_billing_plan`, `create_one_time_charge` → `spend` with full gate diff + live-subscription warning; `create_billing_plan`, `list_billing_plans` join the set; names lock table + tools doc updated on purpose | `assign_billing_plan` → proposal, Stripe spy 0, preview lists gates on/off incl. `api-access`; on a live-subscription fixture the preview says "prorated now"; `invite_member` for an existing admin as collaborator → preview "role admin → collaborator"; approve → `createInviteServerSide` once with pinned values; `outbound-never-sends.test.ts` iterates agency-callable caps |
| **A6** docs + live validation | A1–A5 | `agent-api.md` agency section, tools doc, `firestore-collections.md`, `feature-gates.md`; teardown script; status flip | live checklist below |
| **B1…Bn** burn-down | A1 | one group per PR | each PR moves its group out of `grandfathered` and `FROZEN`; the manifest diff is the proof |

## Burn-down order (outline; REVISED 2026-10-04, P1-11)

1. **Expose, no outbound:** `workflow-folders`, `tracked-links`, `reports`,
   `quotes/[quoteId]/pdf` (R), `agency/sub-accounts/[id]` PATCH (W; DELETE
   `hard_delete`), `agency/templates`, `logs/*`, `launchpad`, `order-attention`,
   `billing-attention`, `usage` (all R), the `contacts` / `deals` / `tasks` / `events`
   trees where a tool already covers the method (manifest only).
2. **Expose with a class:** `members/[uid]` and `territories*` /
   `territory-scoping` → new `access_change` (they reshape who can approve);
   `agency/plans/[planId]` → `spend`; `ai-agent/profile` and `channels` →
   `public_change` / `spend` (customer-facing bot prompt, channel enable spends);
   `reputation/{ai-settings,auto-reply}` (auto-reply on = `public_change`);
   `email-suppressions` (`channel_change`); `missed-call` (`outbound`);
   `quotes/convert-to-invoice`, `recheck-card-charge`, `payment-links` (`spend`);
   `checkout-pages`, `funnels` (`public_change`); `webhook-events/redeliver`
   (`outbound`); `prospecting` share (`outbound`); `get-leads` import (W, search R);
   `community` publish (`public_change`); `webinar1/register` (`outbound`);
   `agency/snapshots` capture (W) and shares (`public_change`); `agency/*-config`
   (brand copy — flag for Hein); `media` folders (W).
3. **Exclude:** every connection route (`google*`, `meta*`, `whatsapp*`,
   `whatsapp-bridge*`, `twilio*`, `smtp*`, `resend*`, `stripe-connection`,
   `paystack-connection`, `paypal-integration`, `apexgeo-connection`,
   `import/ghl/connect`), `billing/{checkout,portal}`, `payment-mandates/revoke`,
   `setup/*`, `website/*`, `refresh-gitpage-status`, `workflows/[workflowId]/test`,
   `calendar.ics` + `calendar-feed-url`, `gbp/*`, `agents/watchdog`, `affiliates/*`,
   `email-purchasers`, `health`, `ai-models`, `contacts/[contactId]/notes/mention-tasks`,
   `import/jobs/*`, **`snapshots/import*`** (a share token from an inbound message
   can plant a persona) and **`webhook-subscriptions*`** (exfiltration channel; v1
   made the writes chat-only), `pay/`, `l/`, `rr/`, `report/` (public, token-authed).

## Firestore changes

- `firestore.rules`: `canSeeProposal` gains `(p.get("subAccountId", null) == null &&
  isAgencyOwner(p.agencyId))`; the new agency subcollections stay under the default
  deny.
- `firestore.indexes.json`: `agentProposals (agencyId ASC, keyLevel ASC, status ASC,
  createdAt DESC)`. The revoke sweep reuses `(keyId, status)`.
- Deploy order: the index **before** the A5 app deploy (a missing index is a runtime
  `FAILED_PRECONDITION` on the agency page, not a CI failure); rules after A5. Both
  from `main`, after checking no other open PR carries rules changes. Rollback for
  rules = redeploy the previous `main`'s file.

## Live validation (after A6, prod, agency CrestaHQ, no real contacts, no outbound to real people)

0. **Reach census first** (REVISED, P1-5): list every sub-account with both gates on
   (Blitz and Velocity carry v1 agent keys and are likely reachable, with real
   contacts). Hein rules whether to switch `agent-api` off on them for the window or
   accept that the key can read them; nothing below touches them.
1. Owner switches on `agentApiEnabled` (Agency → Agency Assistant card); mints an
   agency key. `claude mcp add --transport http leadstack-agency
   https://crm.crestahq.com/api/mcp --header "Authorization: Bearer lsk_live_…"`.
2. `list_sub_accounts` shows exactly the census set. `find_contacts` with a
   gate-off client's id and with a made-up id → the same body minus `request_id`.
3. `create_sub_account "Agency agent smoke <ts>"` → both gates ticked; member = the
   owner, no `apikey:` member; both gate audit rows present.
4. On the smoke sub-account only: `apply_snapshot` → counts, workflows draft;
   `create_pipeline`, `create_custom_field`, `create_product`, `create_snippet`,
   `create_workflow`, `create_booking_page`, `set_sub_account_gate labs true` → direct.
   `set_sub_account_gate whatsapp true` → `gate_change` proposal; `agent-api true` on
   #1000 → proposal; `labs true` on #1000 → proposal.
5. Proposals: `set_workflow_status active`, `update_booking_page status published`,
   `invite_member` (Hein's own address), `assign_billing_plan` (a test plan) → rows.
   `/agency/approvals`: Approve all takes the activation + publish rows; the invite
   and plan rows need their own click; the plan preview shows the gate diff. Reject
   the plan if prod Stripe would send a checkout anywhere but the screen.
6. REST: `POST /api/v1/tools/find_contacts` with `{subAccountId}` → 200; without →
   400; a v1 sub-account key with another `subAccountId` → 400 `wrong_sub_account`.
7. Revoke → remaining pending rows `rejected: key_revoked`; switch off
   `agentApiEnabled`; **`scripts/teardown-smoke-sub-account.mjs`** (REVISED, P1-9):
   deactivates and deletes workflows, deletes forms, products, booking pages and
   the sub-account, then asserts no top-level doc still carries its id. Screenshots
   redacted before commit.

## Open risks

- **Highest risk: `resolveReach` is the whole tenancy boundary** for a key that
  reaches every gated client of an agency — one `agencyId` compare and two gate
  reads; a regression is a cross-client leak at agency scale.
- **Strongest argument against the design:** one agency key is a skeleton key; a
  prompt-injected agent can enumerate and edit every gated client workspace, where
  v1 keys bounded blast radius to one client. The per-sub-account gate, proposals,
  the class-limited Approve all and the kill switch shrink that, they do not remove it.
- **Existing gated clients are reachable the moment a key is minted** (P1-5): v1's
  per-client opt-in is reinterpreted as agency-wide consent. If Hein wants a
  separate reach gate or a key-level target list, it is a ruling change, not a PR.
- `subAccountId: string | null` ripples through every consumer; the compiler lists
  them and A2 asserts no `subAccounts/null` write, but a consumer that stringifies
  the null is not a type error.
- `FROZEN` can only shrink by convention; the diff and the PR-template line are the gate.
- Plan apply after a run can switch gates on or off, including `api-access`; the
  preview shows it, nothing else re-applies gates.
- Rate limit is per process and per key; agency keys share `LIMITS_BY_SCOPE.agent`.
- No viewer for agency-level request logs; no key expiry; no run id.

## Review round 1 reconciliation (2026-10-04)

Adopted: P0-1, P0-2, P0-3 (owner amendment), P1-1, P1-3, P1-4, P1-6, P1-7, P1-8,
P1-9, P1-10, P1-11, and the P2 items on `wrong_sub_account`, path-derived level,
the vacuous rules test, the two gate-off fixtures, the `keyLevel` index + deploy
order, the shared rate-limit dial, `list_sub_accounts` truncation, cached replies,
the kill-switch location, the `agent-proposals` contradiction, `assistantMayEnable`,
test-mode mint, and the A3 / A4 split. P1-2 adopted except as noted below; P1-5
adopted as the census step, with the design question left to Hein.

Refuted or narrowed, with evidence:
- **P1-2 "members has GET covered and POST uncovered":** `members/route.ts` exports
  `GET` only (line 18); invites are `invite/route.ts`. Per-method keys are adopted on
  their own merit (`sub-accounts/[id]` is PATCH + DELETE).
- **P1-2 "enforce the shrink against `origin/main`":** not adopted; the deploy
  checkout runs the same `pnpm lint` and a buyer's generated repo has no such ref,
  so the check would pass vacuously where it matters. Stated as review-enforced.
- **P1-5 "add a separate reach gate":** contradicts the ruling "the key reaches
  only sub-accounts where `agentApiEnabledByAgency` is true"; kept as a ruling
  question for Hein plus the census step.
- **P2 "threat model: cross-tenant data movement is a POPIA issue":** recorded, not
  designed against — both tenants belong to the same agency, and the agent returns
  what any reachable read returns; reach + audit are the bound.
