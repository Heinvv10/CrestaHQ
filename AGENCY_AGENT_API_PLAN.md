# Agency Agent API (Agent API phase 2)

> Status: **PLAN, rev 3 (2026-10-04, blind review rounds 1–3: REJECT → ACCEPT)**.
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
> `agent-api` and `api-access` are never enabled by the key. **Owner ruling (POPIA,
> 2026-10-04):** every reachable sub-account belongs to the agency, and an agent moving
> data between two of them is a bounded risk Hein accepts; each targeted call gets an
> agency-level audit row so it is reconstructable. **RULED 2026-10-04: yes — single
> gate; the mint dialog lists the reach** (review P1-5: reach stays the two
> `apiAccessEnabledByAgency` + `agentApiEnabledByAgency` gates, existing clients included,
> no second switch). Order: coverage gate → keys + onboarding + approvals page → burn-down.

## Goal

An agent holding one `lsk_live_…` key minted at `agencies/{agencyId}/apiKeys` calls
the same `POST /api/mcp` and `/api/v1/tools[/{name}]` as v1 and can onboard a new
client end to end. Every v1 invariant holds per target sub-account: nothing reaches a
person, activates automation, bills anyone or publishes until a human approves it,
and the human can approve the whole run from one page.

## Findings that shape the plan (verified in code, 2026-10-04)

- **Key lookup already spans collections.** `findApiKeyByPrefix` (`api-keys.ts:234-245`)
  is a `collectionGroup("apiKeys")` query on the `apiKeys.prefix` COLLECTION_GROUP
  override (`firestore.indexes.json:1076`): a doc at `agencies/{id}/apiKeys/{keyId}`
  is found with no new index. `snapToDoc` keeps data fields only, not the path.
- **Every key re-read assumes a sub-account path:** `createProposal`
  (`agent-proposals.ts:109`), the decide route, the enrolment replay
  (`agent-enrolment-replay.ts:97`, defaulting the cap to 50 when missing),
  `bumpApiKeyLastUsed(candidate.subAccountId, …)` (`auth.ts:271`), the revoke hook
  (`api-keys.ts:182-218`), `agentActor` (`helpers.ts:290-297`, no level: a held
  enrolment from an agency key would land `hold_refused`), the `apiKey` `Pick`
  (`capabilities/types.ts:67-70`), and `agentPrecheck` (`agent-precheck.ts:19`).
- **Reach needs two gates.** Auth requires `apiAccessEnabledByAgency`; precheck and
  dispatch require `agentApiEnabledByAgency`. `createSubAccountForAgency`
  (`sub-accounts-service.ts:198-232`) writes the agent gate `false` and never writes
  the API gate; it writes the caller as admin member (`:248-268`, from `uid: ctx.uid`
  at `agency.ts:286`), which on the agent surface is `apikey:<prefix>`.
- **Surfaces default open.** `availableOn` treats no `surfaces` as every surface
  (`capabilities.ts:365-370`); all 8 agency caps have none; `inSubAccount` copies
  `base.surfaces` (`:188`) and drops the approval fields (`:189-190`). Only
  `level === "sub-account"` in `agentCallable` keeps them off the agent surface.
  `FEATURE_GATES["agent-api"]` has no `assistantMayEnable: false` (`helpers.ts:245`);
  there is no `email-domain` gate key and `get-leads` is conditional.
- **Plans change reach.** `apiAccessEnabledByAgency` and `emailDomainEnabledByAgency`
  are `PLAN_GATE_KEYS` (`billing.ts:25-26`); `assignPlanToSubAccount` applies
  `plan.gates` both ways (`billing-service.ts:621`) and reads the plan live
  (`:505-541`); a live subscription switches immediately, prorated (`:542-548`);
  no `billing` doc is `comped`, never paywalled (`billing/status.ts:48`).
- **Onboarding seams.** `applySnapshot` is deterministic-id and retry-safe, writes
  workflows `draft` (`apply.ts:399`), forms (`:316-328`), the AI persona when none
  is set (`:149-174`) and remaps `notify` nodes to `accountContact` (`:121`).
  `set_workflow_status active` is `workflow_activate`; a publishing booking-page
  edit is `public_change`; `invite_member` is chat-only and re-roles or adds verified
  users directly (`members.ts:79`); the billing caps have no approval class.
  `agency/sub-accounts/[id]` PATCH takes `name`, `timezone`, `sendWindow`,
  `bookingLink`, `defaultPhoneCountry`, `automationsPaused`, `accountContact`.
- **Teardown is not free.** `deleteSubAccountForAgency` refuses while `forms`,
  `products`, `contacts`, … exist (`sub-accounts-service.ts:55-68`) and
  `recursiveDelete` covers only the sub-account subtree (`:150-152`).
- **Validators drop unknown keys** (`str()`, `helpers.ts:18-21`; no JSON-Schema check
  in `agent-mcp.ts`), so a v1 key sending `subAccountId` is ignored, not refused.
- **Routes.** 221 `route.ts` under `sub-accounts/**` + `agency/**` (172 / 49); tenant
  routes also live under `api/{community,events,comms,contacts,deals,tasks,quotes,
  broadcasts,workflows,forms,automations,scheduled-messages,social,…}` and outside
  `api/` (`src/app/{l,pay,rr,report}/**`, one `route.tsx`). `members/route.ts` is
  `GET` only; `sub-accounts/[id]` is `PATCH` + `DELETE`. The Agency Assistant switch
  is `PATCH /api/agency` (`agency/route.ts:198-205`). `workflows/[workflowId]/test`
  sends for real. `list_sub_accounts` applies `.limit(50)` before any filter
  (`agency.ts:36`). The daily api-cleanup sweeps idempotency by collection group.
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
**REVISED 2026-10-04 (P0-2; r2 P2-1):** `inSubAccount` sets `surfaces` to
`base.surfaces ∩ ["chat"]` (an agent-only base keeps no surface, preserving the
guard at `capabilities.ts:186-188`) and `agentCallable` refuses any
`*_in_sub_account` name on both levels; `resolveReach`
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

- **"Key-created"** (REVISED r2, P2-4; r3 P2-4/5) = `createdByKeyId` equals the
  acting key (`auth.keyId` in dispatch, `row.keyId` on the approvals page, computed
  by the list route at render time) **and** created < 72 h ago **and** `contacts`
  count 0 **and** `!hasChannelConnection(sub)` — one predicate over `twilioConfig`,
  `resendConfig`, SMTP, `metaConfig`, WhatsApp Cloud + bridge, Google, Stripe /
  Paystack / PayPal, shared with the teardown guard.
- **Direct** only on a key-created target **and** for a gate in `DIRECT_GATES`.
  **REVISED r3 (P2-1):** three sets over the exact `FEATURE_GATES` **keys**:
  `DIRECT_GATES` = `labs`, `community`, `website`, `social-planner`, `prospecting`,
  `google-calendar`, `webinars`, `payments`, plus `get-leads` when present;
  `PROPOSAL_GATES` = `missed-call-text-back`, `broadcasts`, `outbound-voice`,
  `sms-agent`, `web-chat`, `inbound-voice`, `whatsapp`, `meta-inbox`, `meta-agent`,
  `reviews-ai`, `reviews-auto-reply`, `ai-suite`, `google` (they start replies, spend
  or tear down); `ENABLE_REFUSED` = `agent-api`, `api-access` and every
  `assistantMayEnable: false` key. The test partitions the keys present at runtime,
  so a new gate defaults to proposal and a parked gate cannot break it.
- Everything else is a `gate_change` proposal (new class; agency-level row; the
  preview names the gate, direction and the side effect from `feature-gates.md`).
  **REVISED r2 (P2-3):** `agent-api` / `api-access` enables are an outright
  refusal — `resolveReach` already 404s any target with either off, so the proposal
  path could never be reached; enabling stays a Manage-dialog click.
- `create_sub_account` on the agent surface writes both reach gates `true`,
  records the two gate audit rows, stamps `createdByKeyId`, and (REVISED, P1-3)
  writes the membership docs for the **owner who minted the key**
  (`key.createdByUid`), never `apikey:<prefix>`. **REVISED r2 (P2-5, P2-7):** the
  per-key cap (10 per UTC day) and the dedupe (`(keyId, name)` within 10 min) are a
  transactional counter doc `agencies/{id}/apiKeys/{keyId}/creations/{YYYY-MM-DD}`
  and a lock doc `…/creations/name_{sha(name)}` with a 10-min `expiresAt`, no
  query and no new index; auth re-checks that `key.createdByUid` still holds
  `role == "owner"` **and** `status == "active"` by one read of
  `agencies/{id}/agencyMembers/{uid}` (`AgencyMemberDoc`, `types/tenancy.ts:1072-1076`;
  r3 P2-8 + post-SHIP, A2: never the Auth Admin API per request), else 401
  `minter_removed`.
- `apply_snapshot` is direct only on key-created targets; elsewhere it is a
  `public_change` **agency-level** row (REVISED r2, P2-6: a sub-account row would
  hit `requiredRole: agencyOwner` on the client's route), so only the owner approves it.

**REVISED 2026-10-05 (A4a-1), following the code:**
- `hasChannelConnection(sub)` lives in `src/lib/agency/channel-connections.ts`
  (no server imports, so the A6 teardown script imports it). It is true when any
  of these `SubAccountDoc` fields is set: `twilioConfig`, `resendConfig`,
  `smtpConfig`, `mailboxConfig` (IMAP inbox), `metaConfig`, `whatsappCloudMeta`,
  `whatsappBridgeMeta`, `whatsappSenders` (non-empty), `googleConnectionMeta`,
  `stripeConnectionMeta`, `paystackConnectionMeta`, `paypalConfig`,
  `webinar1ConnectionMeta`, `apexgeoConnected` (`true`), `ghlImportConfig` (GHL
  import connection). `mailboxConfig`, `webinar1ConnectionMeta`,
  `apexgeoConnected` and `ghlImportConfig` go beyond the list above: they are
  connections to outside accounts too, and each only makes a direct write rarer.
  Connections kept off the doc (per-member Google Calendar tokens, AI channel
  configs under subcollections) are not seen; the same key, < 72 h and 0
  contacts still bound what "key-created" lets through.
- `reviews-auto-reply` is **not** in `PROPOSAL_GATES`: it is
  `assistantMayEnable: false`, so it is in `ENABLE_REFUSED`, and the partition
  test allows one home per key. Behaviour is the same either way (enable refused,
  disable a proposal). `ENABLE_REFUSED` still names `agent-api` and `api-access`
  itself, pinned by a test with every `assistantMayEnable` flag stripped.
- The partition test requires every runtime `FEATURE_GATES` key to be in a set,
  so a new gate fails CI until it is classified; at runtime an unclassified gate
  routes to a proposal (`gateRoute`).
- The "two gate audit rows" of an agent create are one `feature_gates.updated`
  event with two `changes` (both gates `false → true`), actor
  `{type: "api_key", id: keyId}`; `recordGateChanges` takes a uid or an actor. A
  direct `set_sub_account_gate` write is audited the same way, as the key; an
  approved one as the approving owner.
- Creation via a key: the sub-account's and the templates' `createdByUid` is the
  minter, whose standing (key unrevoked, minter an active owner) is re-read in
  the creating transaction. The lock is keyed by the name normalised (NFKC,
  Unicode format characters `\p{Cf}` dropped, whitespace collapsed, lower case;
  variation selectors and homoglyphs still differ, bounded by the daily cap); the
  sub-account keeps the name as given, and a name with no letter or digit once
  normalised (the blank-rendering Hangul fillers aside) is refused. A lock hit replies with the stored name and is flagged `deduped`, so it
  files no `agent.write`. The name lock is checked before the day
  cap, so a repeat within 10 min returns the existing id even on a capped day; a
  lock whose sub-account was deleted since creates anew and moves the lock. The counter and lock docs are not
  swept (that would need a collection-group index): one per key per UTC day, one
  per key per distinct name.
- Executing a `gate_change` row is the capability's own `execute` with
  `ctx.approved` set: it re-anchors `args.subAccountId` to the approver's
  `agencyId`, re-checks `ENABLE_REFUSED`, and writes through `applyFeatureGates` +
  `recordGateChanges` (side effects included). Without `ctx.approved` it writes
  only after re-checking DIRECT + key-created at write time. The preview reads the
  target under `buildPreviewContext(agencyId, targetSubAccountId)`, so A5 rebuilds
  it with the row's `targetSubAccountId` (as D4 r3 P2-2 says). Until A5 ships, these
  rows cannot be approved (owner ruling, 2026-10-05).
- Dispatch's agency-level branch now queues proposals (`queueProposal`, shared
  with the sub-account pipeline) and runs direct writes; a direct agency-level
  write logs `agent.write` under the sub-account it created or changed (else the
  target). A `subAccountId` the tool's validate drops (`create_sub_account` takes
  none) is refused 400 `invalid_args`, so no client's trail names it. `agencyAgentCallable` also requires `availableOn(cap, "agent")`,
  so the chat-only `set_feature_gate` is refused even if named in the set.
- Carry-forward: every created sub-account, a key's included, starts with
  `sms-agent`, `web-chat` and `inbound-voice` on (the opt-out defaults in
  `writeNewSubAccount`), though they are `PROPOSAL_GATES`; unreachable today (no
  `ai-agent/*` agent tool), so the burn-down PR that exposes `ai-agent/channels`
  must class channel enable as `spend` there (as this plan already lists it).

**REVISED 2026-10-06 (A4a-2), following the code** (owner decisions of the
same day: an imported snapshot is always a proposal; self-apply is refused;
no `apply_snapshot` row is ever in "Approve all"):
- `apply_snapshot` is direct only for a snapshot captured in this agency onto
  a target `isKeyCreated` for the calling key, re-checked in `execute` before
  the write. "Imported" fails closed: `importedFrom` set **or** no
  `sourceSubAccountId`. A direct apply's `createdByUid` is the key's minter
  (read from the key doc), an approved one's the approving owner.
- Unknown snapshot ids (another agency's included: the read is
  `agencies/{ctx.agencyId}/snapshots/{id}`) throw the new `CapabilityNotFound`,
  which dispatch answers 404 `not_found`, one body for both. Self-apply
  (`sourceSubAccountId == subAccountId`) is 400. Both are refused in
  `approvalFor`, so no row is ever queued for them, and again in `preview`
  and `execute`.
- The preview's counts come from `planSnapshotApply`
  (`src/lib/snapshots/apply-plan.ts`), which reuses `applySnapshot`'s own
  deterministic ids, existence check and persona predicate (exported, the
  owner route's behaviour unchanged). It pins `snapshotId` and a sha256 of the
  stored payload; `execute` on the approved path refuses a payload whose hash
  is not the pinned one.
- Audit: the direct path's `agent.write` names the snapshot as its target
  (new audit target type `snapshot`); the approved path's `aiSuiteActions`
  row carries `args.snapshotId` and `resultRef`. No `snapshot.applied`
  action was needed.
- "Approve all": `NEVER_BATCHED` (`agency-batch.ts`) excludes the
  capability, not the `public_change` class, so booking-page publish rows on
  key-created targets still batch.
- `list_snapshots` reads `orderBy("createdAt", "desc").limit(51)` and shows
  50 (a doc without `createdAt` is not listed, as in the owner UI's list).
- The coverage names test now accepts an agency-callable tool, so the two
  snapshot routes map to `list_snapshots` / `apply_snapshot`.
- Fix round 1 (adversarial review):
  - The preview's AI persona row names the target's AI channels switched on
    (`aiAgent/{channel}.enabled`) when the persona will be written: they skip
    replies only while the prompt is blank, so the write starts them
    answering. A channel switched on after proposing is `preview_changed`.
  - **`applySnapshot` changed for every caller (owner route, template push,
    agent):** a target profile that exists with a blank prompt is merged into
    with the five persona fields capture copies (`systemPrompt`, `hoursStart`,
    `hoursEnd`, `timezone`, `escalationKeywords`); its other fields (business
    name, escalation inbox, website + KB, anything an operator set) stay.
    Before, the whole doc was replaced. And a custom-field definition's id is
    now target-wide per `(entity, key)`, written with `create()`, so two
    applies racing on one key (or a payload naming it twice) leave one
    definition; ALREADY_EXISTS counts as skipped.
  - `execute` reads the minter first; the direct re-check (target re-read,
    contacts counted) is the last read before the write. A window remains
    from that re-check to the commit: a contact (or channel connection) that
    lands while `applySnapshot` does its own pre-reads still gets a direct
    apply. Closing it would need the re-check and the writes in one
    transaction; `set_sub_account_gate` has the same window.
  - A malformed stored payload (a part of the wrong shape) applies nothing
    instead of failing: every list is coerced to an array of objects.
- Fix round 2 (adversarial review):
  - **`applySnapshot`, every caller:** a target with no `aiAgent/profile` but
    an unmigrated legacy `aiConfig/main` whose prompt is set keeps it: the
    persona is not written (writing a profile stops `maybeMigrateLegacy`,
    which migrates only while no profile exists, and the legacy persona was
    lost). The preview says "Kept".
  - A written persona brings the snapshot's hours and timezone too (what
    travels is prompt, hours, timezone, keywords), including onto an existing
    blank-prompt profile; the AI persona row now says so, with the values.
  - `list_snapshots` rows start with the id, label every field, and quote
    name and description with their quote characters and `|` neutralised, so
    an imported snapshot's text cannot forge a field.
- Fix round 3 (review LOWs):
  - **`applySnapshot`, every caller:** with no profile, a legacy
    `aiConfig/main` with a blank prompt is migrated first, with the same
    `migratedLegacyDocs` the lazy migration uses (profile + sms channel), then
    the persona merged in, so its inbox, business name and SMS config stay.
    The plan treats the legacy doc as the profile and its `enabled` as the
    sms channel, so the lazy migration running between propose and approve
    changes nothing. An existing profile always wins over a legacy doc.
  - The AI persona row says which hours land: the snapshot's, the target's
    own (kept), or the defaults.
  - Snapshot and target names in the preview's Snapshot row and the result
    text go through the same neutralised quoting as `list_snapshots`.
  - `legacyAiConfigPath` / `migratedLegacyDocs` live in
    `src/lib/comms/ai/legacy-config.ts`, shared by agent.ts, model-policy.ts
    and the snapshot apply.
- Fix round 4 (review LOWs):
  - The lazy migration (`maybeMigrateLegacy`) now `create()`s the profile:
    one that read "no profile" before an apply committed no longer overwrites
    the merged persona; it skips its writes and the caller reads the profile
    that exists. Its two writes are sequential (profile, then sms).
  - An hours field that neither the snapshot nor the existing profile has is
    written as the default by the merge, and the row says "the defaults".
- Fix round 5: the lazy migration `create()`s the sms channel too (sms first,
  then the profile), and the apply's migration writes sms only when no sms
  doc exists; the plan reads an existing sms doc's `enabled`. A late
  migration can no longer switch an operator's SMS bot back on.

### D4 — approvals: two row kinds, one new page

- **Sub-account-scoped rows** from an agency key are ordinary `agentProposals` rows
  with `subAccountId = target` plus `keyLevel: "agency"`; they land on
  `/sa/[id]/approvals` as today **and** on the agency page.
- **Agency-level rows** (`assign_billing_plan`, `create_one_time_charge`,
  `gate_change`, `apply_snapshot` off a key-created target) have `subAccountId: null`, `agencyId`, `keyLevel: "agency"`,
  `targetScoped: false`, `targetSubAccountId` for display; id
  `p_<sha256("agency:"+agencyId|capability|args)>`.
- `/agency/approvals` (max-w-5xl) lists `agencyId == mine ∧ keyLevel == "agency"`
  (index `(agencyId, keyLevel, status, createdAt DESC)` — REVISED, P2), grouped by
  target sub-account. **REVISED r2 (P1-A):** "Approve all" covers only
  `workflow_activate` and `public_change` rows **on key-created targets**; every
  other class (`gate_change`, `workflow_enrolment`, `channel_change`, `outbound`,
  `spend`, `hard_delete`) is approved one row at a time, and the button shows what
  it will skip. Batch = a sequential client loop over the per-row decide routes.
  **REVISED r2 (P1-B):** the pre-claim sequence of the sub-account route
  (`[proposalId]/route.ts:153-252`: validate → key re-read → expiry → preview
  rebuild with `preview_changed` → `priorAttemptSent` → `rev`-guarded claim) is
  factored into `lib/server/agent-proposals-decide.ts` and shared. **REVISED r3
  (P2-2):** it takes `targetSubAccountId` (the row's `subAccountId`, or
  `targetSubAccountId` for an agency row) and uses it for the gate re-check (both
  reach gates still on, so an owner cutting a client off freezes its queued agency
  rows: 403), the preview ctx and `SettleAudit.subAccountId`; nothing is ever read
  or written under `subAccounts/null`. The agency route
  (`/api/agency/agent-proposals/[proposalId]`) adds only `requireAgencyOwnerAny`,
  agency match else 404, `roleSatisfies(…, {agencyRoleIsOwner: true})` and the kill
  switch, then `executeAndSettle`. **REVISED r3 (P2-3), corrected post-SHIP (A4b):**
  `assignPlanToSubAccount` gains an `expectedPriceCents` + `expectedGates` argument
  and refuses `pinned_mismatch` inside its own plan read (`billing-service.ts:505-541`),
  so nothing can move between the compare and the write. `specialPriceCents` is
  sent **only when the proposal itself set one**: passing the pinned base price as
  a special price would stamp `billing.specialPriceCents` and fork a per-sub-account
  Stripe price (`:536-541`), after which plan price changes never reach the client.
  No batch endpoint: claim, `rev`, pins, deadline and `unsettled` are untouched.
- One `agentKeyRef(row)` (by `keyLevel`) serves `createProposal`, both decide
  routes, the enrolment replay and `agentActor` (REVISED, P1-1).
- Previews: `assign_billing_plan` pins `planId`, price, interval and shows **every
  gate going on and off**, flags `api-access` and `email-domain`, and says
  "switches the live subscription now, prorated" when one exists (REVISED, P1-4);
  `create_one_time_charge` pins amount, currency, description; `invite_member`
  (`outbound`) pins email + role and shows "existing member: role X → Y" or "added
  immediately, nothing to accept" (REVISED, P1-8). `create_billing_plan` bills
  nobody: direct, joins the set in A4b.
- **REVISED 2026-10-05 (A3b review, carry-forward to A5):** `proposalId` is
  action-scoped, not key-scoped, so an agency-key row frozen by its key's standing
  (switch off or minter removed → approve 403) is what a sub-account key re-proposing
  the same action gets back, until someone rejects it or it expires. A5 decides
  whether the decide routes or `createProposal` should roll such a row over.
- **REVISED 2026-10-05 (A3b follow-ups):** the A5 race carry-forward is resolved.
  The approve claim now re-reads, inside its own transaction, everything the
  decide route checked before it (both sub-account gates, the row's agency, the
  proposing key, an agency key's standing, the row's territory against the
  approver's scope, its expiry) through the same helpers,
  `lib/server/agent-approval-checks.ts`. A revoke, switch-off, minter demotion,
  gate-off, contact re-tag or expiry committing between the checks and the
  claim no longer executes: a revoked key rejects the row `key_revoked`, an
  expired one expires it (409), anything else leaves it pending with the early
  check's 403 / 404. A5's shared pre-claim
  sequence calls `claimProposal` and inherits it.
- **REVISED 2026-10-06 (A5), following the code:**
  - `agent-proposals-decide.ts` holds everything after a route authorises the
    person — reject and mark_* as well as approve — so both decide routes are
    thin and the agency route also settles an unsettled agency-level row
    (`mark_sent` / `mark_not_sent`), which had no other surface. The target is
    `proposalTarget(row)` (`subAccountId ?? targetSubAccountId`);
    `approvalRefusal` reads it too, and a row naming neither is `gate_off`
    (the agency route answers it 404), so nothing reads `subAccounts/null`.
  - The `gate_change` preview gained a "Now" row (the gate's stored state,
    default-on fields as `recordGateChanges` reads them): without it a gate
    flipped since proposal rebuilt an identical preview, so approve could not
    say `preview_changed`. A row queued before A5 answers `preview_changed`
    once on its first approve.
  - `GET /api/agency/agent-proposals` requires `?status=` (`open`, `recent`
    or one status), so the one new index serves every query; the status
    groups moved to `statusFilter` in `agent-proposals-view.ts`, shared with
    the sub-account list route. A row whose target is not in the owner's
    agency is left out of the list.
  - Rollover: the old generation goes to `history` with `status:
    "superseded"`. The check is `keyRefusal` (the key half of
    `approvalRefusal`, factored out), read with `tx.get` in the create
    transaction. Symmetric: a revoked v1 key's pending row is superseded by
    an agency key the same way.
  - With rollover a row's id can change hands between generations, so:
    each generation carries `gen` (set by `createProposal`, kept by a
    preview refresh); the revoke sweep moves a pending row only at the
    `gen` it queried (the `rev` for a row from before `gen`), so a refresh
    mid-sweep cannot strand a revoked key's row, and the expiry sweep only
    at the `rev` it queried. Both approval cards send `gen`; a decision
    naming another `gen` is 409 `stale_proposal`, reject included, so a
    stale card cannot reject a different key's generation. A reject with
    a `rev` but no `gen` (a card loaded before `gen`) lands once the row
    has a `gen` only if that `rev` is the row's current one or its `gen`
    (the generation's first rev), else 409 `stale_proposal`; checked in
    the transaction. Otherwise reject ignores `rev` (a refresh must not
    block it), and a row without `gen`, or a reject with no `rev`, is
    checked as before.
  - "Approve all" also skips a row whose earlier attempt already went out
    (`priorAttemptSent`): that needs the in-app re-send confirmation.
  - The E2E proposes through the REST tools route with an agency key the
    spec mints, on two sub-accounts it creates and deletes, rather than
    seeding rows: approve rebuilds the preview and refuses any difference,
    so a seeded preview would have to reproduce the server's byte for byte.

### D5 — the per-key questions

| Concern | Decision |
|---|---|
| Tenancy anchor | `resolveReach` in dispatch for every `subAccountId`; downstream the scoped `ctx.subAccountId`; agency caps anchor on `ctx.agencyId` |
| Cross-agency / gate-off | one 404 body (compared minus `request_id`); fixtures for gate-off in each direction; `list_sub_accounts` filtered |
| Rate limit | per key, v1 numbers; `LIMITS_BY_SCOPE.agent` is shared with sub-account agent keys, so an agency-only dial means a new row (REVISED, P2) |
| Enrolment cap | per key **per sub-account** (bucket under the target); replay reads the cap via `agentKeyRef` |
| Idempotency (REST) | per key, `agencies/{id}/apiIdempotency/{mode_keyId_hash}`; body in the fingerprint, so another `subAccountId` = `idempotency_collision`; **REVISED (P2):** `precheck` receives the parsed body and runs `resolveReach` on `body.subAccountId` before the idempotency lookup, so a cached reply never outlives a gate switch |
| Request logs | **REVISED (P1-7):** logged under `subAccounts/{target}` only after `resolveReach` succeeds; every refusal and agency-level call → `agencies/{id}/apiRequestLogs` (no viewer this phase); test: a refused call writes nothing under any sub-account |
| Audit actor | `{type: "api_key", id: keyId}` + `keyLevel`; `agent.write` under the target; creation / snapshot / gate flips under the sub-account they touch; **REVISED r2 (P2-12):** plus one `agent.call` row under `agencies/{id}/agentCalls` per targeted call (tool, target, read/write, no args; `expiresAt` +30 d, swept by the api-cleanup collection-group pass, default deny — r3 P2-7), so cross-client reads are reconstructable |
| Revoke sweep | `sweepRevokedKeyProposals({keyRef, agencyId})` on the `(keyId, status)` index, no sub-account filter |
| Kill switch | `agencies/{id}.agentApiEnabled`: auth, dispatch (fresh), both decide routes for `keyLevel: "agency"` rows |
| Billing plan at creation | none: `comped`, fully usable; `assign_billing_plan` is a `spend` proposal approved last |
| Human-only | no tool for any connection route, credentials, `billing/{checkout,portal}`, `PATCH /api/agency` (the switch itself) |

**REVISED 2026-10-05 (A3b), following the code:**
- `sweepRevokedKeyProposals` takes `{keyRef}` only: a row is the key's when
  `agentKeyRef(row).path === keyRef.path`, and an agency key's path already names its
  agency, so a separate `agencyId` would be redundant.
- The `agent.call` row also carries `keyId` and `keyPrefix` (which key, never args),
  is written **before** the call runs (a call whose row cannot be written does not
  run), and is written for an agency-level call that names a reached
  `subAccountId` (`sub_account_stats`) as well as for every sub-account call.
- The enrolment replay refuses a missing proposing-key doc at **either** level
  (never the default cap); the decide route already treats a missing key as
  revoked, so only a race reaches it.
- Approving an agency key's row re-checks everything auth checks of the key, through
  the same helper (`agencyKeyStanding`): the agency switch **and** the minter still
  an active owner (403 otherwise), after the revoke check; and the row's `agencyId`
  must equal the sub-account's (else 404), since the key re-read is keyed by it.
  These gate **approve** only; reject stays allowed (refusing is always safe).
- An agency key sending no `subAccountId` to a sub-account tool gets the identical
  404 `not_found` (A3a's `resolveReach` on `undefined`), not a 400: live-validation
  step 6 below reads "→ 404".
- `precheck`'s type already took `ApiAuthContext | AgencyApiAuthContext` after A3a;
  nothing to widen.

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
refuse any addition. **REVISED 2026-10-05:** since PR #345 the shrink rule is CI-enforced:
`FROZEN` moved to `scripts/agent-coverage-frozen.json`, and
`.github/workflows/agent-coverage-shrink.yml` runs
`scripts/check-agent-coverage-shrink.mjs` on every PR, comparing it with `main` and
failing on any added key. `src/lib/api/agent-coverage.test.ts` (**`pnpm test`**) checks
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
`templates*`, `updates-modal-config`. **REVISED r2 (P1-C):** the other trees
(`api/community`, `events`, `comms`, `contacts`, `deals`, `tasks`, `quotes`,
`broadcasts`, `workflows`, `forms`, `automations`, `scheduled-messages`, `social`,
`pay`, `report`, `l`, `rr`, …) are declared in scope by the tree list, and every
existing `path:METHOD` inside them is its own `FROZEN` entry; a new route inside a
grandfathered tree fails like any other (A1 fixture). Exclusions at A1:
`api-keys*` (key-management), `agent-proposals*` (queue-itself: no tool exists for
the queue), `PATCH /api/agency` (human-only), inbound `webhooks/*` (public-unauth).

## Module shape

```
src/types/api.ts, lib/api/auth.ts            level + subAccountId | null; agency auth branch; withApiAuth allowAgencyKey; precheck(ctx, body)
lib/firestore/api-keys.ts                    agency key CRUD; agentKeyRef(row); level from path; bump / revoke by ref
lib/api/agent-dispatch.ts                    AGENCY_AGENT_CALLABLE; resolveReach; agency branch; wrong_sub_account
lib/api/agent-tools-listing.ts (NEW)         agentToolsFor(auth); agent-context / precheck / logs / idempotency by level
lib/server/agent-proposals*.ts, agent-proposals-decide.ts (NEW), agent-enrolment-replay.ts
                                             keyLevel, agency ids, gate_change, shared pre-claim sequence, sweep + cap via agentKeyRef
lib/ai-suite/capabilities/…                  helpers (agentActor level, assistantMayEnable), agency, agency-gates (NEW), snapshots (NEW), billing-*, members
lib/server/sub-accounts-service.ts           createdByKeyId, owner membership on the agent path, counter + lock docs
app/api/agency/{api-keys,agent-proposals}/** (NEW); agency/route.ts + agency-assistant-section.tsx (switch + keys card)
app/(dashboard)/agency/approvals/page.tsx + sidebar (NEW)
scripts/check-agent-coverage.mjs + agent-coverage.json; lib/api/agent-coverage.test.ts; scripts/teardown-smoke-sub-account.ts
firestore.rules / firestore.indexes.json
```

## PR DAG (REVISED 2026-10-04: A3 and A4 split; each ≤ ~500 lines incl. tests; blind `/review` per PR)

| PR | Depends | Content | `verify:` (failing first) |
|---|---|---|---|
| **A1** coverage gate | — | checker (all `src/app/**/route.*`, per method, tree list, exact `FROZEN`) + manifest + names test; PR-template line | checker against `scripts/__fixtures__/agent-coverage/`: an unlisted `path:POST` → exit 1 naming it; a listed route that is gone → 1; `exclude` without category → 1; a `grandfathered` glob or an entry outside `FROZEN` → 1; a new top-level tree → 1; the real tree → 0. **Mutation:** stub the unlisted branch → the first fixture goes green, so the test asserts exit code + the `path:METHOD` in stderr. Names test: a misspelled tool → red |
| **A2** agency keys + switch | — | `level` from the doc path; agency CRUD; auth branch on `agentApiEnabled` + minter-still-owner check; `withApiAuth`, `/api/mcp` and the tools routes refuse agency keys; bump / revoke by key ref; routes + card; `assistantMayEnable: false` on `agent-api` and `api-access` (REVISED r2, P2-9: closes the chat path now; the PR says owners lose "enable API access" in chat) | `auth.agency-key.test.ts`: agency key → `/api/v1/contacts` 403 `agency_key_not_allowed`; → `/api/mcp` 403, row under `agencies/{id}/apiRequestLogs`; switch off → 403; revoked → 401; mint `["agent","admin"]` or `mode:"test"` → 400; after every case no doc under `subAccounts/null`. **Mutation:** drop the `withApiAuth` refusal → red |
| **A3a** reach + listing | A2 | `resolveReach` (generic on any `subAccountId`), `AGENCY_AGENT_CALLABLE = {list_sub_accounts, sub_account_stats}`, variants chat-only + refused by name, `agentToolsFor`, logs / idempotency by level, `precheck(ctx, body)`, `wrong_sub_account`; transports still refuse agency keys. **Carry-forward (A2 review):** A3a adds a distinct `keyLevel` on the scoped context — today's `level` conflates where the key lives with whether the context has a sub-account | `agent-dispatch.agency.test.ts`: sa2 (other agency), sa3 (agent-api off), sa5 (api-access off) → identical 404 minus `request_id`; sa1 → `find_contacts` rows of sa1 only; a refused call writes no log under any sub-account; `agent-callable-set.test.ts` = named set exactly, no `*_in_sub_account` callable (iterates the registry); a sub-account key with another `subAccountId` → 400. **Mutations:** stub the `agencyId` compare → sa2 goes red; add `set_feature_gate` to the set → red |
| **A3b** keyLevel threading | A3a; **deploy precondition: reach census + Hein's ruling** (REVISED r2, P2-8: keys reach existing clients from this deploy, not A6) | `agentKeyRef` in `createProposal`, both decide routes, enrolment replay, `agentActor`, revoke hook + sweep; `keyLevel` on rows; `agent.call` audit; transports accept agency keys. **Carry-forward (A2 review):** replace the agency-key early return in `agent-proposals-revoke-hook.ts` with a sweep across every reached sub-account; `agent-proposals-revoke-hook.test.ts` pins today's no-op and must be rewritten | agency-key `create_contact` matching an ACTIVE workflow → one `workflow_enrolment` row with `keyLevel: "agency"`, no hold failure; approve via the existing decide route → execute once, cap reserved from the agency key doc; revoke → pending rows in sa1 **and** sa4 → `rejected`; switch off → dispatch 403 and approve 403; MCP `tools/list` for an agency key requires `subAccountId` on every sub-account tool, a sub-account key sees the v1 set exactly |
| **A4a-1** create + gates | A3b | `create_sub_account` agent path (both gates, owner membership, `createdByKeyId`, counter + lock docs); `set_sub_account_gate` + `DIRECT_GATES` partition test + `gate_change`; `set_feature_gate` chat-only (REVISED r2, P2-10: snapshots split out) | via agency key: both gates `true`, member doc = owner uid, no `apikey:` member, 11th creation that day → refused, same name within 10 min → same id (two concurrent creates → one doc); via chat: unchanged. Gates: `labs true` on a key-created target → written; the same target 73 h later or with one contact → proposal; `whatsapp true` anywhere → `gate_change` proposal; `agent-api true` → refused; `google false` on an existing target → proposal (mutations: drop the `createdByKeyId` check → red; add a gate to no set → partition test red) |
| **A4a-2** snapshots | A4a-1, A5 | `list_snapshots`, `apply_snapshot` | key-created target → direct, workflows `draft`, persona written only when absent; other target → agency-level `public_change` row, approved on the agency route only. **BUILT 2026-10-06** (`feat/agency-agent-a4a2`; see REVISED (A4a-2) under D3) |
| **A5** agency approvals page | A3b | shared pre-claim sequence (`agent-proposals-decide.ts`) + agency list / decide routes; `/agency/approvals`; sidebar + badge; class-limited Approve all; `canSeeProposal` branch; index | decide route: other agency's owner → 404; a sub-account row → 404; expired row → 409; a `gate_change` row whose target gate flipped since → `preview_changed`; two concurrent approves → execute once, 200 + 409; switch off → 403; an agency row whose target's `agent-api` went off → 403 and no write under `subAccounts/null` (r3 P2-2). Sub-account route test suite re-run unchanged against the factored sequence. Rules test: agency row readable by its owner only (mutation: drop the branch → red). `e2e/specs/agency-approvals.spec.ts`: seed a `workflow_activate` row on a key-created target, a `gate_change` row and an email `send_message` (no SMTP) → Approve all approves the activation only and leaves the other two pending; one by one → `executed` / `failed` with the seam's refusal (mutation: add `gate_change` to the batch set → red) |
| **A4b** invite + billing | A4a, A5 | `invite_member` → `outbound` with the existing-member preview; `assign_billing_plan`, `create_one_time_charge` → `spend` with full gate diff + live-subscription warning; `create_billing_plan`, `list_billing_plans` join the set; names lock table + tools doc updated on purpose | `assign_billing_plan` → proposal, Stripe spy 0, preview lists gates on/off incl. `api-access`; on a live-subscription fixture the preview says "prorated now"; edit the plan's price between propose and approve → 409 `preview_changed`, Stripe spy 0, and a plan edited after the claim → execute refuses `pinned_mismatch` (REVISED r2, P1-B); `invite_member` for an existing admin as collaborator → preview "role admin → collaborator"; approve → `createInviteServerSide` once with pinned values; `outbound-never-sends.test.ts` iterates agency-callable caps |
| **A6** docs + live validation | A1–A5 | `agent-api.md` agency section, tools doc, `firestore-collections.md`, `feature-gates.md`; `scripts/teardown-smoke-sub-account.ts` (REVISED r2, P1-D: TypeScript so `tsc` covers it); status flip | teardown unit test: refuses a target failing any one of name prefix `Agency agent smoke `, `createdByKeyId` set, created < 72 h (aligned with key-created, r3 P2-6), `contacts` = 0, `!hasChannelConnection`, or run without `--yes` (prints the doc list and stops); then the live checklist below |
| **B1…Bn** burn-down | A1 | one group per PR | each PR moves its group out of `grandfathered` and `FROZEN`; the manifest diff is the proof |

## Burn-down order (outline; REVISED 2026-10-04, P1-11)

1. **Expose, no outbound:** `workflow-folders`, `tracked-links`, `reports`,
   `quotes/[quoteId]/pdf` (R), `agency/sub-accounts/[id]` **per field** (REVISED
   r2, P1-E): `name`, `timezone`, `defaultPhoneCountry` W; `automationsPaused →
   false` and `sendWindow` `outbound` (resume sends, widen quiet hours);
   `accountContact` `channel_change` (snapshot `notify` nodes route to it,
   `apply.ts:121`); `bookingLink` `public_change`; DELETE `hard_delete`), `agency/templates`, `logs/*`, `launchpad`, `order-attention`,
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
   `whatsapp-bridge*`, `twilio*`, `smtp*`, `resend*`, `*-connection`,
   `paypal-integration`, `import/ghl/connect`), `billing/{checkout,portal}`,
   `payment-mandates/revoke`, `setup/*`, `website/*`, `refresh-gitpage-status`,
   `workflows/[workflowId]/test`, `calendar.ics` + `calendar-feed-url`, `gbp/*`,
   `agents/watchdog`, `affiliates/*`, `email-purchasers`, `health`, `ai-models`,
   `contacts/[contactId]/notes/mention-tasks`, `import/jobs/*`, `snapshots/import*`
   (a share token from an inbound message can plant a persona),
   `webhook-subscriptions*` (exfiltration channel), `pay/`, `l/`, `rr/`, `report/`.

## Firestore changes

- `firestore.rules`: `canSeeProposal` gains `(p.get("subAccountId", null) == null &&
  isAgencyOwner(p.agencyId))`; the new agency subcollections stay under the default
  deny.
- `firestore.indexes.json`: `agentProposals (agencyId ASC, keyLevel ASC, status ASC,
  createdAt DESC)`; **post-SHIP (A3b):** a COLLECTION_GROUP-scope ascending
  `expiresAt` index on `agentCalls`, which joins `EXPIRES_AT_COLLECTION_GROUPS`
  (`cron/api-cleanup/route.ts:38-46`; the index-coverage test enforces the pair),
  deployed before the A3b app deploy. The revoke sweep reuses `(keyId, status)`.
- Deploy order: the index **before** the A5 app deploy (a missing index is a runtime
  `FAILED_PRECONDITION` on the agency page, not a CI failure); rules after A5. Both
  from `main`, after checking no other open PR carries rules changes. Rollback for
  rules = redeploy the previous `main`'s file.

## Live validation (after A6, prod, agency CrestaHQ, no real contacts, no outbound to real people)

0. **Reach census** (REVISED r2, P2-8: done before the **A3b** deploy, repeated here):
   list every sub-account with both gates on (Blitz and Velocity carry v1 agent keys
   and are likely reachable, with real contacts). Switching `agent-api` off on them
   would break the live `leadstack-blitz` / `leadstack-velocity` triage tooling and
   block their pending proposals; Hein ruled (2026-10-04) that the key reaches them,
   and the mint dialog lists them by name. Nothing below touches them.
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
   `set_sub_account_gate whatsapp true` → `gate_change` proposal; `agent-api true`
   → refused; `labs true` on #1000 → proposal.
5. Proposals: `set_workflow_status active`, `update_booking_page status published`,
   `invite_member` (Hein's own address), `assign_billing_plan` (a test plan) → rows.
   `/agency/approvals`: Approve all takes the activation + publish rows (the smoke
   sub-account is key-created); the gate, invite and plan rows need their own click; the plan preview shows the gate diff. Reject
   the plan if prod Stripe would send a checkout anywhere but the screen.
6. REST: `POST /api/v1/tools/find_contacts` with `{subAccountId}` → 200; without →
   404 (REVISED A3b); a v1 sub-account key with another `subAccountId` → 400 `wrong_sub_account`.
7. Revoke → remaining pending rows `rejected: key_revoked`; switch off
   `agentApiEnabled`; **`scripts/teardown-smoke-sub-account.ts --yes`** (REVISED,
   P1-9 / r2 P1-D, P2-11): guards above, then deactivates and deletes workflows,
   deletes forms, products, booking pages, snippets, pipelines, message templates
   and the sub-account, then asserts `workflows`, `bookingPages`, `forms`,
   `products`, `message_templates`, `snippets`, `pipelines`, `customFields` hold no
   doc with its id. Screenshots redacted before commit.

## Open risks

- **Highest risk: `resolveReach` is the whole tenancy boundary** for a key that
  reaches every gated client of an agency — one `agencyId` compare and two gate
  reads; a regression is a cross-client leak at agency scale.
- **Strongest argument against the design:** one agency key is a skeleton key; a
  prompt-injected agent can enumerate and edit every gated client workspace, where
  v1 keys bounded blast radius to one client. The per-sub-account gate, proposals,
  the class-limited Approve all and the kill switch shrink that, they do not remove it.
- **Existing gated clients are reachable from the A3b deploy** (P1-5, **RULED
  2026-10-04: yes — single gate; the mint dialog lists the reach**): v1's
  per-client opt-in is reinterpreted as agency-wide consent.
- `subAccountId: string | null` ripples through every consumer; the compiler lists
  them and A2 asserts no `subAccounts/null` write, but a consumer that stringifies
  the null is not a type error.
- `FROZEN` can only shrink by convention; the diff and the PR-template line are the gate.
- Plan apply after a run can switch gates on or off, including `api-access`; the
  preview shows it, nothing else re-applies gates.
- Per-process per-key rate limit shared with v1 agent keys; no agency-log viewer,
  key expiry or run id; cross-client data movement is bounded only by reach + audit.

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
  **REVISED 2026-10-05:** PR #345 enforces it in CI after all, in its own workflow
  (`agent-coverage-shrink.yml`) that fetches `main` and fails closed without it;
  `pnpm lint` and the deploy script still do not run it.
- **P1-5 "add a separate reach gate":** contradicts the ruling "the key reaches
  only sub-accounts where `agentApiEnabledByAgency` is true"; kept as a ruling
  question for Hein plus the census step.
- **P2 "threat model: cross-tenant data movement is a POPIA issue":** now an owner
  ruling (header): a bounded risk Hein accepts, with the `agent.call` audit row.

### Round 2 (2026-10-04, head b735a807 → this commit)

Adopted: P1-A (batch = `workflow_activate` + `public_change` on key-created targets
only), P1-B (shared pre-claim sequence; `spend` executes enforce pins), P1-C
(per-route `FROZEN` inside grandfathered trees), P1-D (TypeScript teardown with
target guards and `--yes`), P1-E (per-field classes for the sub-account PATCH), and
P2-1, P2-2, P2-3 (refusal replaces the unreachable proposal), P2-4 (72 h / 0
contacts / no channel), P2-5 (counter + lock docs, no index), P2-6 (agency-level
row), P2-7 (minter-still-owner check), P2-8 (census before A3b), P2-9, P2-10 (A4a
split), P2-11, P2-12 (owner ruling + `agent.call` row). Nothing refuted this round;
the reviewer's two UNVERIFIED items stand as written: production gate state is the
census step, and `labs` / `prospecting` gate no outbound feature
(`feature-gates.md`: Labs is a container; Prospecting sends only through the
workflow approach guard, which the key never reaches directly).

### Round 3 (2026-10-04, ACCEPT; head 87134983 → this commit)

Adopted in the plan: P2-1 (three sets over the real keys, runtime partition), P2-2
(`targetSubAccountId` through the shared pre-claim module), P2-3 (pinned price via
`specialPriceCents`, gate map compared in the call), P2-4 (`row.keyId`, computed by
the list route), P2-5 (`hasChannelConnection` predicate, fields named), P2-6
(teardown window = 72 h), P2-7 (`agentCalls` TTL + sweep), P2-8 (`agencyMembers`
doc read), P2-9 (status line). Carry-forward into the owning PR: the exact field
list behind `hasChannelConnection` is fixed in A4a-1 when the predicate is written
(the teardown in A6 imports it), and the `agentCalls` sweep joins the api-cleanup
route in A3b. **Post-SHIP carry-forwards (verified 2026-10-04):** A4b uses an
expected-price argument, not `specialPriceCents`; A3b adds the `agentCalls`
collection-group `expiresAt` index; A2's minter check reads `role` and `status`.
