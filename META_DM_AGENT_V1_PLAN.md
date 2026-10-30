# Meta DM Agent v1 (AI auto-reply on Messenger + Instagram)

> Status: **BUILT 2026-07-21** (typecheck + lint clean; NOT yet
> runtime-verified against a live Meta app — verify with a tester DM on a
> dev Meta app: expect a bot reply on Messenger and Instagram, a paused bot
> after a manual inbox reply, and a draft card in suggest mode). Picks as
> locked: (1) single toggle with IG capability auto-guard, (2) gate opt-IN
> and NOT pre-ticked in Client Billing plans, (3) straight to shipped (no
> Labs). Raised by a buyer ("is
> AI auto-reply available to toggle on for Facebook and Instagram?"). The
> Meta inbox was deliberately display-only ("Phase A" in the webhook header
> comment); this is Phase B: the shared AI agent answering inbound
> Messenger + Instagram DMs, exactly like it answers SMS and WhatsApp.

## Goal

An inbound Messenger or Instagram DM gets an AI reply from the sub-account's
shared agent persona — same guards, same escalation, same operator controls
(auto / suggest-draft / off, human-takeover pause) the SMS and WhatsApp bots
already have. One toggle at AI Agents → "Messenger & Instagram".

## Why the lift is small — what already exists

- **The orchestrator is transport-pluggable by design.**
  `maybeRespondWithAi()` (lib/comms/ai/respond.ts) runs identical guards →
  context → LLM → send → log for SMS + WhatsApp, parameterized by a
  4-field `ChannelTransport`. Meta is a fifth transport, not a new pipeline.
- **Conversation AI controls come free.** The orchestrator already reads
  `getConversationControls()` — bot mode (auto / draft / off) and
  `botPausedUntil` (human takeover on any manual reply, incl. the existing
  Meta send route which passes `pauseBot: true`). A Meta bot inherits all
  of it with zero new code.
- **Draft mode is 90% wired.** `ConversationDraftCard` already carries
  `messenger` / `instagram` labels; only its approve-endpoint mapping needs
  a meta branch (the meta send route already exists).
- **Outbound IG works now.** The (#3) send-node bug (fixed 2026-07-21)
  would have broken every IG auto-reply; sends now go via the Page node.
- **Webhook plumbing done.** Inbound routing, signature check, contact
  reconciliation, `metaMessages` row, conversation upsert, gate
  re-enforcement — all shipped. Dispatch is the only missing call.
- **Booking block + KB + escalation** ride `buildSystemPrompt()` — free.

## Design

### One channel, replies mirror the inbound platform

New `ConfiguredChannelId`: **`"meta"`** — ONE channel config doc
(`subAccounts/{id}/aiAgent/meta`), one toggle, covering both platforms.
Rationale: both ride one Meta connection and one agency inbox gate (they
connect/disconnect together); the reply always goes back on the channel the
message arrived on (`messenger` | `instagram` from the webhook event), so
there's nothing per-platform to configure. Instagram replies are
additionally guarded by `metaCanInstagramDm(metaConfig)` — a connection
whose token lacks `instagram_manage_messages` auto-replies on Messenger
only (the settings section surfaces this with the existing capability
badge language).

### Agency gate

New **`metaAgentEnabledByAgency`** — **opt-IN** (`=== true`), the WhatsApp
precedent: the channel never pre-existed the gate, and it spends OpenRouter
credits. Added to `CHANNEL_GATE` in lib/comms/ai/gates.ts (+
`anyAiChannelGateOn`), and wired through the standard 6-step gate checklist
(SubAccountDoc field, `false` at both creation sites, feature-gates PATCH
branch, Manage-dialog checkbox, assistant `FEATURE_GATES` map,
`PLAN_GATE_KEYS` for Client Billing plans — NOT in `DEFAULT_ON_PLAN_GATES`).
Effective bot = `metaInboxEnabledByAgency` (inbox exists) AND this gate
(AI spend) AND channel doc `enabled` AND persona non-empty.

### Transport (lib/comms/ai/respond.ts)

`getChannelTransport` gains a meta variant, parameterized by the inbound
platform so activity labels read "Messenger" / "Instagram":

- `messagesCollection: "metaMessages"` — shared collection with a `channel`
  discriminator, so the history loader gains an optional channel filter
  (SMS/WhatsApp pass none; behavior unchanged).
- `isOptedOut: () => false` — Meta has no STOP semantics; blocking is done
  by the user on-platform. Documented inline.
- `send` — `sendMetaMessage({ channel, fromNodeId: pageId, recipientId:
  contact.metaUserId, ... })` from `subAccount.metaConfig`. No 24h-window
  guard needed (same reasoning as WhatsApp: the orchestrator only fires on
  a just-received inbound, so the window is open by definition).
- `RespondInput.contactPhone` generalizes to `replyTo` (mechanical rename —
  it's the reply destination: phone for Twilio channels, `metaUserId` here).
- Outbound row keyed by the returned Meta message id (matches the manual
  send route's dedupe model).

### Webhook dispatch (app/api/webhooks/meta/route.ts)

After the conversation upsert, when the sub-account passes the gates and
`aiIsConfigured()`: `await maybeRespondWithAi({ channelId: "meta", ... })`
with the reconciled contact + message text. Awaited (serverless can't
fire-and-forget) but outcome-swallowed — the route still always returns 200
so Meta never retry-storms. Echoes/non-text events are already dropped
before this point.

### Safety rails (lib/comms/ai/prompt.ts)

New `meta` branch, WhatsApp-adjacent: 1–2 short conversational paragraphs,
**plain text only** (no markdown — Messenger/IG render it literally), light
emoji ok, plain URLs ok (booking block works), hard cap ~900 chars (IG's
message limit is 1000), markerless (reply sent verbatim; no `[[capture]]`
parsing — the contact already exists via webhook reconciliation, so
capture adds nothing on this channel).

### Draft-mode approve path

`ConversationDraftCard`'s endpoint map adds: `messenger`/`instagram` →
`POST /api/comms/meta/send` with `{ contactId, body, channel }`. The send
route's existing 24h-window guard applies — a draft approved after the
window closes surfaces the route's clear 409 message (correct behavior:
Meta forbids that send).

### UI

- Channel registry entry in components/ai-agents/channels.ts:
  "Messenger & Instagram" (shipped, not hidden).
- Settings section (`meta-channel-section.tsx`, mirroring
  whatsapp-channel-section): enable toggle, model override, context count,
  escalation overrides, token counter. Readiness states: agency gates off →
  Locked; no Meta connection → "Connect under Settings" hint; connection
  without `instagramDm` capability → amber "Messenger only until you
  reconnect with Instagram access".
- Conversation AI controls / thread / composer: no changes — they're
  already channel-generic.

## Guards / correctness

- Bot never replies to its own sends: webhook already drops `is_echo`.
- Human takeover: any operator reply (composer or draft-approve) pauses the
  bot via the existing `pauseBot` upsert — unchanged.
- Rate/abuse: per-channel `totalTokensUsed` counter accrues as on other
  channels; Meta-side send rate limits surface through the existing error
  mapper (`describeMetaSendError` codes 4/613).
- Meta policy: automated responses inside the standard 24h messaging window
  are permitted; no human-agent tag involved. App Review scope chain is
  unchanged (`pages_messaging` + `instagram_manage_messages` already cover
  bot sends).
- Tenancy: no new collections, no Firestore rules changes (`aiAgent/*` docs
  are already member-read / server-write; `metaMessages` rules shipped).

## Explicitly deferred (v2+)

- Rich replies (images, quick-reply buttons, story replies) — text only.
- Out-of-window re-engagement via message tags.
- Instagram comment / story-mention handling (webhook drops non-message
  events today; unchanged).
- Per-platform enable sub-toggles (see open pick 1).
- Web-chat-style `[[form]]` capture markers on Meta (not needed — contact
  identity is inherent to the channel).

## Setup contract

**No new env vars.** Reuses `META_APP_ID`/`META_APP_SECRET`/
`META_WEBHOOK_VERIFY_TOKEN`, `OPENROUTER_API_KEY`, existing Firestore
rules. Buyers need nothing beyond flipping the new gate + toggle.
`update-ai-kb` skill run after build so the assistants know the channel
exists.

## Effort

~1.5–2.5 days: transport + history channel-filter + webhook dispatch +
rails branch + gate checklist + settings section + draft endpoint branch +
manual two-way test on a dev Meta app.

## Open picks (decide before locking)

1. **Single toggle (recommended) vs per-platform sub-toggles** — one
   `enabled` flag, IG auto-guarded by capability; or nested
   `{ messengerEnabled, instagramEnabled }` like the webChat block. Single
   is less UI and matches the one-connection model; sub-toggles help an
   operator who wants the bot on IG but human-only on Messenger.
2. **Gate default** — opt-IN recommended (WhatsApp precedent, new spend).
   Confirm you don't want it bundled into any existing Client Billing plan
   automatically.
3. **Ship state** — straight to shipped (recommended — it's a fifth
   transport on a proven pipeline, and the inbox itself is already
   beta-gated) vs Labs first.
