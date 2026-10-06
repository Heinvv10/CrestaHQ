# Agent API

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](README.md).*

Lets an external LLM agent (Claude Code, Claude Desktop, an n8n AI node, your own
script) work inside one sub-account through the same tool registry the in-app AI
assistant uses, over MCP or a REST mirror. Reads and ordinary edits run directly.
Anything that reaches a person, spends money, goes public, activates automation or
deletes for good becomes a **proposal** that someone in the sub-account approves on
its **Approvals** page. The agent never sends a message itself.

- Tool table (generated from the registry): **[agent-api-tools.md](agent-api-tools.md)**
- Plan and owner rulings: [AGENT_API_V1_PLAN.md](../../AGENT_API_V1_PLAN.md)
- The rest of the public API (keys, REST resources, webhooks): [public-api.md](public-api.md)

## Enabling it

1. **Agency gate.** The agency owner turns on **Agent API** for the sub-account in
   the Manage dialog on the agency's sub-accounts list (`agentApiEnabledByAgency`,
   `FEATURE_GATES["agent-api"]`). It is standalone, not a plan perk: applying a
   billing plan never switches it. It sits on top of `apiAccessEnabledByAgency`,
   and both are re-read on every request (off → 403 `agent_api_disabled`).
   Pending proposals can't be approved while it is off. See
   [feature-gates.md](../architecture/feature-gates.md).
2. **Agent key.** A sub-account admin mints a key with the `agent` scope in
   the **API Keys** section of Settings. The scope is exclusive with `admin` and `forms-ingest`,
   and only a **live** key works: a test-mode key is refused before any tool runs.
   Revoking the key rejects its pending proposals (`key_revoked`).

An agent key acts as a sub-account admin for reads and direct writes (no territory
limits). The approver's role and territory are what gate a proposal.

## Connecting

### MCP (`POST /api/mcp`)

Streamable HTTP, stateless (GET and DELETE → 405). Claude Code:

```bash
claude mcp add --transport http leadstack https://<your-app>/api/mcp \
  --header "Authorization: Bearer lsk_live_…"
```

- `tools/list` lists the same tools as `GET /api/v1/tools`: `inputSchema` is the
  tool's JSON Schema, reads carry `annotations.readOnlyHint`, and a tool that needs
  a person carries its approval class in `_meta: {approval}`.
- A write returns its result text (plus `structuredContent` `{ref?, held?,
  holdFailures?}`); a tool that needs a person returns a text naming the queued
  proposal (`structuredContent.proposal: {id, status, summary, preview}`); a
  refusal is an `isError` result with `{error: {code, message}}`.
- A bad key, a key without the `agent` scope, a test-mode key or the gate off is
  refused at the HTTP level with the v1 error body, before any call runs.
- A JSON-RPC batch that repeats a request id is refused whole (`-32600`).
- Request log: each `tools/call` that runs is logged as `/api/mcp#<tool>`, with the
  same body rules as REST (bodies only for a callable write; its validated args,
  never the raw ones). Calls refused by the rate limit inside a batch share ONE
  `/api/mcp` row with their count. A request refused by the route before its
  messages run (scope, test mode, gate, rate limit, invalid JSON, a repeated id, an
  oversized body) is logged as `/api/mcp` without bodies; nothing else is
  (`initialize`, `tools/list`, or a refusal from the MCP transport itself, e.g. a 406).

### REST

- `GET /api/v1/tools` → `{tools: [{name, description, parameters, readOnly, approval?}]}`.
- `POST /api/v1/tools/{name}` with the args as the JSON body. A write returns 200
  `{result, ref?, held?, holdFailures?, truncated?}`; a tool that needs a person
  returns 202 `{proposal: {id, status, summary, preview}}`. Details, error bodies
  and logging: [public-api.md](public-api.md#agent-tools-agent-scope).

### Agency keys

An agency owner can mint an **agency key** (`agencies/{id}/apiKeys`, Agency →
Agency Assistant card) once the agency's **Agent API** switch
(`agencies/{id}.agentApiEnabled`) is on. It works on the same three transports —
`POST /api/mcp`, `GET /api/v1/tools`, `POST /api/v1/tools/{name}` — and on no
other route: every other `/api/v1` route refuses it with 403
`agency_key_not_allowed`. Plan: [AGENCY_AGENT_API_PLAN.md](../../AGENCY_AGENT_API_PLAN.md).

- **Reach.** Every sub-account tool takes a required `subAccountId` (the listing
  adds it to each schema). The key reaches a sub-account of its own agency with
  both `apiAccessEnabledByAgency` and `agentApiEnabledByAgency` on; anything else —
  another agency's, a gate off, no `subAccountId`, a made-up id — gets one identical
  404 `not_found`. `list_sub_accounts` lists the reachable ones.
- **Cut-off.** The switch off (403 `agent_api_disabled`, re-read on every call), the
  key revoked (401) or its minter no longer an active owner (401 `minter_removed`)
  stop every transport. Revoking rejects the key's pending proposals in every
  sub-account; while the switch is off or its minter is no longer an active
  owner, its rows can't be approved (403).
- **Proposals** an agency key causes are ordinary rows of the target sub-account
  (`keyLevel: "agency"`), approved on that sub-account's Approvals page; held
  enrolments are charged to the agency key's enrolment cap, counted per
  sub-account.
- **Audit.** Each call in a sub-account writes one `agent.call` row under
  `agencies/{id}/agentCalls` (key, tool, target, read or write — never the args),
  kept 30 days. Request logs land under the target once reach lets the call
  through; refusals and agency-level calls log under the agency (no viewer yet).
- **Rate limit:** the same per-key numbers as a sub-account key.
- **Idempotent replays log under the agency.** A REST call answered from the
  `Idempotency-Key` cache never reaches dispatch, so its request log lands under
  the agency and it writes no `agent.call` row; the original call logged under its
  target and wrote its row. Deliberate, not fixed.

## Tools

97 tools today; the full table, with each tool's kind, role and what its approval
preview shows, is **[agent-api-tools.md](agent-api-tools.md)**. It is generated
from the registry and a test fails when it drifts. After adding or changing an
agent capability, rerun:

```bash
UPDATE_AGENT_API_DOCS=1 pnpm exec vitest run src/lib/ai-suite/agent-api-doc.test.ts
```

A new tool that can need approval also needs a line in `PREVIEW_NOTES`
(`src/lib/ai-suite/agent-api-doc.ts`); the same test fails until it has one.

The agent surface is the sub-account-level capabilities that declare the `agent`
surface. Webhook writes, member invites, the website / community / course
builders, checkout pages, payment links and mandates, API keys, feature gates and
anything agency-level are not on it.

**Approval classes:** `outbound` (a message to a person), `workflow_activate`,
`hard_delete`, `spend` (bills or charges), `channel_change` (a contact's phone or
email, which redirects sends already approved), `public_change` (what the public
sees, books or is sent from a booking page, or a social post going public), and `workflow_enrolment` (engine only,
below). Some tools need approval only for some calls (e.g. `set_bot_mode` to
`auto`, `set_event_status` to `cancelled`, `update_workflow` on an active
workflow); the table's Kind column says when.

## The approval queue

A proposal is one `agentProposals/{id}` row (rules: read by the sub-account's
members, no client writes; see
[firestore-collections.md](../architecture/firestore-collections.md)).

- **Preview and pins.** At propose time the tool builds the preview: the exact text,
  resolved recipient, channel, amount, or the record about to go. The values the
  send depends on (recipient, channel, body, the number it goes out from: the SMS
  Twilio number, the WhatsApp rail's connected number, the number the voice line was
  imported to Vapi from; fingerprints of the quote, workflow or call script) are
  **pinned** with it. A scheduled message re-checks its recipient and number when it
  fires. On approve the preview is rebuilt; if
  anything differs the approve is refused `preview_changed` and the page reloads
  the new preview, and execute sends only to the pinned values.
- **Checks at send.** The downstream send re-checks what the approver saw
  (`expect`): the review-request text, number and channel; the quote a
  `send_quote` sends; the cancellation notice and the appointment's contact (a cancel
  whose appointment is re-linked mid-flight sends no notice and starts no workflows);
  the steps of the workflows a cancel, mark-paid or held enrolment starts (only the
  reviewed workflows start, and only while their steps are unchanged; a run then reads
  each step when it reaches it); the broadcast's approved audience
  size and the values an agent set on it; the social post's approved accounts; the
  voice call's script fingerprint. A mismatch refuses with nothing sent. For a
  manual-origin send, quiet hours, opt-out, the WhatsApp window and channel
  readiness are decided at approve time with the **approver** as the actor. The
  review requests `mark_deal_completed` and `mark_quote_paid` cause are automated:
  quiet hours hold them and release them later (still re-checked against what was
  approved).
- **Who approves.** Any sub-account member holding the tool's role (the Role column)
  and passing the territory rule for the proposal's contact; `hard_delete` needs a
  sub-account admin. Both agency gates are re-checked.
- **Statuses.** `pending` → `executing` (claimed; a second approve gets 409
  `already_decided`) → `executed` or `failed`; or `rejected` / `expired` (7 days).
  **`unsettled`** means the outcome is unknown: the provider was contacted but could
  not confirm, execute passed its 5-minute deadline, or the process died mid-send.
  It is never `failed`, because a failed row can be re-proposed and sent twice. A
  person checks the conversation and marks it `mark_sent` or `mark_not_sent`
  (allowed 60 minutes after the claim); a late settle from the original attempt
  overrides that mark with the real outcome. Re-proposing an unsettled action is
  refused `outcome_unknown`.
- **Held enrolments (ruling Q).** An agent's direct write still commits, but every
  ACTIVE workflow it would enrol the contact in becomes a `workflow_enrolment`
  proposal instead (returned as `held: [{proposalId, workflowName}]`). Approving
  replays that one trigger for that one workflow, with filters, re-entry and the
  enrolment cap checked again; rejecting leaves the write and enrols nobody. Its
  preview shows the workflow, the trigger and the contact (plus the deal and stage
  for a deal trigger), the workflow's exact steps, and that the first step runs as
  soon as it is approved (a speed-to-lead workflow approved an hour later still
  runs its first step then). The steps' fingerprint is pinned: steps edited after
  the hold make the approve `preview_changed`, and steps edited after the approve's
  check enrol nobody. An **approved** action runs as the approver did it, so its own
  triggers enrol normally. Tenant webhook subscriptions are not held.
- **Identity.** Proposal ids are deterministic (sub-account, tool, canonical args),
  so the same action proposed twice is one pending row, whichever key proposes it.
  A row carrying `priorAttemptSent` warns that an earlier generation did send and
  needs an explicit acknowledgement to send again.
- **Size.** Args plus preview over 400 KB of JSON are refused at propose.

Every direct agent write also records an `agent.write` audit event
([audit-events.md](../architecture/audit-events.md)); request logs keep bodies
only for callable write tools.

## Idempotency

- **REST** honours `Idempotency-Key` for writes and proposals (the saved response
  is replayed for 24 h). Read tools ignore it.
- **MCP** has no idempotency in v1. Use REST when a retry must not repeat a write.
- Proposals dedupe regardless: an identical pending action returns the same id.

## Rate and cost

- **60 calls/min and 1,000/h per key**, shared by MCP and REST. On MCP every call
  costs one token: a request pays one up front (covering its first `tools/call`),
  each further call in a batch one more, and a request that runs no call still
  costs 1. An exhausted key gets the v1 429 with `Retry-After` and
  `X-RateLimit-*` before anything runs. The limit is per-process memory.
- **Enrolment cap:** approved held enrolments are charged against the key's
  per-hour enrolment cap (default 50).
- **What approvals spend:** messages go out on the sub-account's own providers
  (SMTP, Twilio, WhatsApp); `start_voice_call` uses voice minutes; schedules and
  workflow steps use QStash; `spend` proposals bill or charge the contact.

## Known limits

- **Look-alike names.** Names (snippets, products, custom fields and folders,
  booking pages, schedules) are refused when they imitate another with look-alike
  letters. A few real names with unusual letters or symbols are refused too: the
  click letters (U+01C0, U+01C1, U+01C3), Turkish dotless i (U+0131), Afrikaans
  'n (U+0149), the ordinal indicators (U+00AA, U+00BA), the florin sign (U+0192),
  an "@" or an arrow between two letters, CJK written straight onto a Latin word,
  and a one-letter Cyrillic word that looks Latin.
- **Quote edits during a send.** A person editing a quote in the app while an
  approved `send_quote` goes out is not blocked by the send's claim (the editor
  writes from the browser); the send's fingerprint check refuses a changed quote
  instead of sending it.
- **Broadcast values.** The approver sees each value an agent set that the
  broadcast merges; past 50 such contacts the broadcast must be sent from the app.
  Contacts an agent edits after the proposal are skipped at send.
- **Booking-page previews** show the whole page, not a diff, when it goes public or
  has upcoming bookings.
- **Clocks.** A proposal's `createdAt` is the app server's clock; broadcast edits
  anchor on `createdServerAt` (Firestore's), falling back to `createdAt` for older
  rows.
- **`find_contacts` scans at most 500 contacts**, in document-id order, so in a
  large sub-account it can miss a contact that exists, and an agent that then
  creates it makes a duplicate. A fix is to follow.
- **Territory of deal and task proposals** is fixed at propose time; only contact
  targets re-sync when a contact is re-tagged.
- **No notification** for new proposals in v1; the sidebar badge counts pending and
  unsettled rows.
- **Agency keys reach sub-account tools and the agency tools** `list_sub_accounts`,
  `sub_account_stats`, `create_sub_account`, `set_sub_account_gate`,
  `list_snapshots` and `apply_snapshot` so far; the rest of agent-run onboarding
  is planned in [AGENCY_AGENT_API_PLAN.md](../../AGENCY_AGENT_API_PLAN.md).
