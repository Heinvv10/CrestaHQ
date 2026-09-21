# WhatsApp bridge rail — design

**Date:** 2026-09-04
**Status:** design approved, implementation not started
**Scope:** a third WhatsApp rail (`bridge`) delivered by a new self-hosted Go
service, consumed first by Hermes as an agent control surface and later by
LeadStack for human-approved customer replies.

---

## 1. Why this exists

LeadStack sends WhatsApp over Twilio today and over Meta Cloud once that rail
lands. Both are official BSP rails: they require pre-approved templates to open
a conversation and enforce Meta's 24-hour customer-service window.

The `bridge` rail is different in kind. It pairs to WhatsApp as a **linked
device** using the multi-device protocol — the same mechanism `web.whatsapp.com`
uses — via the `whatsmeow` library. There are no templates, no service window,
no Meta billing, and no Meta support. It is an unofficial rail and it violates
WhatsApp's terms of service. That is stated plainly here because every design
decision below follows from it.

The seam for this rail already exists in the codebase
(`src/lib/comms/whatsapp/provider.ts`), which declares:

```ts
bridge: { supportsTemplates: false, enforcesWindow: false }
```

and every dispatch path already carries a declared `bridge` arm that fails
loudly rather than silently falling through to another rail. This design fills
that slot.

### The problem `enforcesWindow: false` creates

On the official rails, Meta's 24-hour window does double duty. It is a
compliance rule, and it is also an accidental rate limiter that makes cold bulk
outbound structurally impossible.

Remove it and nothing prevents the failure mode that is already documented in
`wa-bridge-ops`, confirmed on 2026-09-04:

> `*events.LoggedOut` — recurring, multiple times/day. DM-to-non-contacts spam
> pattern — FibreFlow sends individual DMs to people who never messaged the
> number; whatsmeow (unofficial client) + outbound-only DMs + high volume
> (~120/day) matches Meta's bot/spam heuristics exactly. Group send_ack path is
> NOT the trigger — individual DMs are. (+063 logged out 12× in one window.)

The same number, the same library, running group acks for months without
incident, was banned within days of sending cold DMs. **The ban signal is
behavioural, not transport-level.** The bridge rail must therefore bring its own
replacement for the window, or it inherits this failure by construction.

### Rejected alternative: browser automation

Driving `web.whatsapp.com` with browser automation was considered and rejected.
It is not stealthier — it is worse:

1. WhatsApp Web is itself a linked device on the same protocol, so the transport
   is identical, but the automation runs *inside Meta's own JavaScript sandbox*
   where canvas/WebGL fingerprints, `navigator.webdriver`, CDP artifacts and
   event `isTrusted` flags are all observable. whatsmeow exposes a wire protocol
   and nothing more.
2. It does not change behaviour, and behaviour is what triggers bans.
3. It costs a headless browser per number (~500 MB–1 GB RSS vs ~30 MB for a Go
   process) and breaks whenever WhatsApp Web ships DOM changes.

The one genuine benefit sometimes claimed for it — human-like pacing — is
implemented directly in this design (rail 7) without the browser.

---

## 2. Library choice: whatsmeow

Checked 2026-09-04:

| | whatsmeow | Baileys |
|---|---|---|
| Latest published | 2026-09-03 | 2026-07-29 |
| Cadence | continuous pseudo-versions | rc12 May 20 → rc13 May 21 → rc14 Jul 29 |
| Stability of `latest` | rolling stable | a release candidate |
| Session persistence | built in (SQLite/Postgres store) | DIY auth-state handling |

whatsmeow is chosen for release velocity — which is what determines recovery
time when Meta forces a protocol bump — and for built-in session persistence,
which a long-lived daemon needs.

**Note on the existing Baileys bridge.** `hermes-agent/scripts/whatsapp-bridge/`
already implements `/send`, `/send-media`, `/send-poll`, `/send-location`, a
serialised send queue, echo dedup (`outbound_ids.js`), a customer allowlist
(`allowlist.js`) and an owner-message gate (`owner_message_gate.js`), each with
unit tests. `LISTEN_ONLY=true` is a deployment flag on the Cortex instance, not a
capability limit.

Reusing it was considered and rejected: it is load-bearing for Cortex ingestion,
it runs a release candidate, and it is paired to the personal number. Its
*patterns* are reused (extracted, unit-tested gate functions); its process,
session and number are not.

---

## 3. Architecture

```
┌─ Hermes (phase 1) ─────────┐   ┌─ LeadStack (phase 2) ──────────┐
│  agent loop, tool calls     │   │  AI draft, CRM state,          │
│  owner conversation state   │   │  approval gate, inbox UI       │
└──────────┬──────────────────┘   └──────────┬─────────────────────┘
           │ HTTP + bearer                    │ HTTP + bearer
           └───────────────┬──────────────────┘
                           ▼
            ┌──────────────────────────────────┐
            │  wa-agent-bridge  (Go, whatsmeow) │
            │  ── SAFETY RAILS ──               │  ← every send passes here
            │  allowlist · reply-only · caps    │
            │  pacing · quiet hours · kill      │
            │  ── transport ──                  │
            │  session store (SQLite) · pairing │
            │  send queue · echo dedup          │
            └──────────────┬───────────────────┘
                           ▼
                    WhatsApp (dedicated number)
```

### Placement of the safety rails

The rails live **in the bridge**, not in its consumers. This was the central
design decision.

The reasoning mirrors an argument the codebase already makes for
`dispatchWhatsappSend`:

> a call site that reaches `sendWhatsappForSubAccount` directly is hardcoded to
> Twilio, so it breaks silently the moment a workspace moves to another rail.

One layer down, the same holds. The 2026-09-04 logout happened because a
consumer (FibreFlow) had unmediated access to a WhatsApp socket. Putting rails
in the consumers rebuilds that: every future consumer must remember to
re-implement them. Putting them at the socket makes the unsafe action
unrepresentable, and any new consumer inherits protection by default.

**Accepted cost:** when a rail blocks a send that looks legitimate, debugging
happens in Go on a VPS rather than in TypeScript in the app. This is mitigated by
machine-readable `refusedBy` reasons surfaced to the consumer, and by rail
counters on the health endpoint.

### Service boundary

The bridge decides *may this send happen*. It never decides *what to say*. No
AI, no CRM, no Firestore, no message composition. That boundary keeps it small,
testable, and prevents it becoming a second application.

### Repository placement

`services/wa-agent-bridge/` inside the CrestaHQ repo, matching the
`services/whatsapp-bridge` convention used in the FF_Next.js repos.

**Constraint:** the Go service must NOT be added to `pnpm ci:check`. It gets its
own CI job (`go vet`, `go test ./...`, `go build`), written when the service is
created. Otherwise a Go build failure blocks Next.js PRs that never touched it.

### HTTP interface

Bearer-token auth, bound to localhost/Tailscale. Never publicly routable.

| Endpoint | Purpose |
|---|---|
| `POST /v1/send` | `{to, text, idempotencyKey, consumer}` → passes rails, or refused with machine-readable `refusedBy` |
| `POST /v1/allowlist` | add/remove a single JID — the only override for reply-only |
| `GET /v1/health` | connection state, last inbound/outbound age, session age, rail counters, kill state |
| `POST /v1/kill` | refuse all outbound, stay connected to receive |
| webhook → consumer | inbound fans out to registered consumer URLs |

### Consumer registry

Each consumer (`hermes`, `leadstack`) holds its own token, rail budget and
inbound webhook URL. This allows throttling or killing one consumer without
silencing the other, and makes "which consumer caused this" answerable from
logs — a question the current runbook answers by grepping for
`Sent message … @lid` immediately before a `LoggedOut` event.

### What is unchanged

The Cortex Baileys bridge and the FibreFlow Go bridge keep running exactly as
they are. This adds a third service; it replaces neither.

---

## 4. Safety rails

Evaluated in order. First refusal wins and returns a machine-readable
`refusedBy`. Fail closed.

| # | Rail | Rule | Rationale |
|---|---|---|---|
| 1 | Kill switch | Refuse all outbound; stay connected to receive | Incident response without going blind |
| 2 | Idempotency | `idempotencyKey` deduped against a persisted table; repeat returns the original result. A key is bound to ONE recipient — reuse across recipients is refused (`idempotency_key_reused`), never answered as a duplicate | Retries must never double-message; and answering a reused key with another contact's result is a silent NON-delivery, which is worse |
| 3 | Consumer budget | Per-token daily + hourly ceiling | Throttle one consumer to zero without affecting the other |
| 4 | Quiet hours | Refuse outside configured local hours, per consumer (each consumer may override the deployment window; unset inherits it) | Ban signal and customer-relations problem alike |
| 5 | **Reply-only** | Outbound to a JID that has never messaged this number is refused | The core protection. Cold DMs killed +063; the reply-only group path survived months |
| 6 | Allowlist | The only override for #5. One JID at a time, explicit call. Never bulk, never by import | Escape hatch that is deliberately painful at volume |
| 7 | Per-contact cap | Max 10 outbound/contact/day; max 3 consecutive outbound with no inbound between | Stops a looping agent machine-gunning one person — the likeliest bug on a rail with no window |
| 8 | Global daily cap | Default 150 outbound/day | Sits below ~120/day, a volume already proven fatal |
| 9 | Pacing | Serialised queue; length-proportional delay + jitter; minimum inter-send gap | Humans do not emit three messages in 400 ms |

**Amended 2026-09-04, after implementation.** This table originally ran
kill → budget → reply-only → allowlist → caps → pacing → quiet → idempotency.
The built order is the one above, and the SPEC was corrected to match the code
rather than the other way round: no rail has side effects and the first refusal
wins, so the two orders return the same verdict for every request and differ
only in the reported `refusedBy` — but the built order puts the cheap gates
first and the expensive Store reads last, so a refused send never pays for
counters nobody will read. Two specific improvements: idempotency now answers a
replay before any counter is consulted, so a retry cannot consume budget; and
quiet hours, which needs no Store read at all, is settled before reply-only and
the caps. `rails/engine.go` documents the same order and
`rails/order_test.go` pins it.

Pacing is listed last because it is not a refusal at all — it is `wa.Queue`
delaying a send the rails have already allowed, one layer below this chain.

### Invariants

**Counters persist to SQLite, never memory only.** `wa-bridge-ops` records this
exact bug on the sibling bridge — dedup "was in-memory only so restart erased it
(fixed PR #2687 which persists dedup state to SQLite)". A rail that resets on
restart is worse than no rail, because a crash-loop becomes a send-loop.

**Rails are pure functions over `(request, state, clock)`, in their own package,
with unit tests.** `rails/` decides; `wa/` transmits. Every refusal is testable
with no WhatsApp connection. The Baileys bridge validates this structure — its
gate was extracted precisely because a previous inline implementation
"accidentally bypassed the customer-side allowlist."

**Rails do not judge content.** Tone and correctness are the consumer's
responsibility, and for customer replies, the human approver's. A content
classifier here would be a second AI in the wrong place.

---

## 5. Phase 1 — Hermes control surface

```
your phone ──DM──▶ wa-agent-bridge ──webhook──▶ Hermes
                        │                          │ agent turn
                        ◀──── POST /v1/send ───────┘
your phone ◀──reply──────┘
```

1. Owner DMs the dedicated number from their personal WhatsApp.
2. Bridge verifies the sender JID matches the configured **owner JID**. In
   phase 1 anything else is logged and dropped — the number is unpublished.
3. Bridge POSTs `{from, text, messageId, quotedMessageId}` to Hermes' webhook.
4. Hermes runs a turn and replies via `/v1/send`.
5. Rails pass trivially: inbound-initiated, one contact, low volume.

Ban risk is close to zero, which is why this is the first consumer: it exercises
pairing, session persistence, send queue, echo dedup, reconnect and webhook
fan-out under real conditions, where the worst case is the owner's own agent
going quiet.

### Required details

**Correlation via quoted messages.** WhatsApp has no threads and several items
will be in flight. Every bridge→owner message carries a `messageId`; a
long-press reply gives Hermes the `quotedMessageId`. This is the correlation key
that attaches an approval to a *specific* draft rather than the most recent one.
Without it, an approval surface over WhatsApp is unsafe — and phase 2's approval
gate depends on it.

**Immediate ack for long work.** An agent turn can take minutes. Send a short
ack, then the result. Two minutes of silence reads as broken and provokes a
re-send, which duplicates the work.

**Message-length discipline.** Terminal output pasted into WhatsApp is
unreadable. Replies on this channel need a hard length budget with truncation
and a "reply MORE" affordance.

### Out of scope for phase 1

No customer contact, no LeadStack, no Firestore. The number stays unpublished.
POPIA exposure is unchanged: the agent may display customer data to its owner
exactly as it already does in a terminal, but nothing new leaves the estate.

### Exit criteria before phase 2

Run phase 1 alone for at least two weeks and confirm: session survives restart
and re-pair; reconnect produces no duplicate replay sends; rails refuse
correctly under real traffic; pacing feels human; approval-by-quoted-reply is
comfortable in daily use.

If the number is flagged doing only this, the concept is invalid — learned for
the price of one SIM rather than a client relationship.

---

## 6. Phase 2 — customer replies via LeadStack

Phase 1 is phase 2's approval surface.

```
customer ──▶ bridge ──webhook──▶ LeadStack
                                    │ writes thread, AI drafts
                                    ▼
                          draft pending approval
                                    │
                   ┌────────────────┴─────────────┐
                   ▼                              ▼
        Hermes → owner's WhatsApp         LeadStack inbox UI
        "Draft for Sipho: …  reply OK"    (approve / edit / send)
                   │                              │
                   └──────────┬───────────────────┘
                      approve ▼
              LeadStack → dispatchWhatsappSend → bridge → customer
```

**Nothing reaches a customer without explicit human approval.** This is a
standing rule in the global CLAUDE.md ("outbound customer communication …
any message reaching a real person" always keeps a human gate), satisfied here
structurally rather than by discipline. Autonomous customer sends are out of
scope for this design.

> **SUPERSEDED 2026-09-08** — see
> [`2026-09-08-multi-sender-whatsapp-design.md`](2026-09-08-multi-sender-whatsapp-design.md)
> ruling 1. Autonomous sends are now in scope, gated per sender: replies to a
> customer-initiated conversation are unrestricted, openers are budgeted, and
> the bridge default stays reply-only.

### LeadStack changes

| File | Change |
|---|---|
| `src/lib/comms/whatsapp/bridge-client.ts` | **new** — HTTP client mirroring `cloud-client.ts`. Maps rail refusal → `DEFINITELY_REJECTED`, timeout → `AMBIGUOUS` |
| `src/lib/comms/whatsapp/bridge-credentials.ts` | **new** — base URL + token at `subAccounts/{id}/private/whatsappBridge`, Admin SDK only (same secret split as Payments v1 and Webinar1) |
| `src/lib/comms/whatsapp/send-dispatch.ts` | replace the "not available yet" `bridge` arm with a real send |
| `src/lib/comms/whatsapp/readiness.ts` | replace the refusal with a configured-and-connected check |
| `src/lib/comms/whatsapp/template-dispatch.ts` | **unchanged** — continues to refuse. `supportsTemplates: false` is correct and permanent |
| `src/app/api/webhooks/whatsapp/bridge/[subAccountId]/route.ts` | **new** — HMAC-verified inbound reusing `verifyWebhookSignature` (the Webinar1 receiver pattern). Add to `PUBLIC_PATH_PATTERNS` |
| settings card | connect/disconnect, pairing QR, live rail counters, kill switch |

Inbound writes to `contacts/{id}/whatsappMessages` — the same subcollection the
Twilio rail uses — so the existing thread UI, unified inbox,
`upsertConversationForMessage`, `message.received` event and push all work
unchanged. Unknown numbers reconcile phone-first and auto-create a contact,
matching the existing Twilio WhatsApp webhook behaviour.

### Policy constraints

**Selecting `bridge` is agency-owner-only.** `twilio` ↔ `cloud` is a commercial
choice a sub-account admin may make. Moving to an unofficial rail carries ban
risk and legal exposure and must be a deliberate agency decision.

> **SUPERSEDED 2026-09-08** by
> [`2026-09-08-multi-sender-whatsapp-design.md`](2026-09-08-multi-sender-whatsapp-design.md).
> Workflow sends ARE carried on this rail, bounded by a per-sender opener
> budget rather than refused outright: the +063 evidence below is about cold
> OPENERS at volume, not about automation as such. Everything downstream of a
> customer's own reply satisfies reply-only and was never the danger. Templates
> and broadcasts remain refused. The paragraph is kept because its reasoning is
> still the reason the budget exists.

**No templates, no broadcasts, no workflow sends on this rail — ever.** The seam
already refuses templates. Extend this: workflow `send_whatsapp` steps and
broadcast audiences must not resolve to `bridge`. These are exactly the bulk
outbound patterns that killed +063. Reply-only would refuse them anyway; better
to refuse at the app layer with a clear message than to emit a pile of rail
refusals.

**Bridge logs carry no message bodies.** The Cortex pipeline already enforces
body-free payloads for POPIA; the bridge follows the same rule. Bodies belong in
Firestore where access control applies, not in a plaintext log on a VPS.

**Lawful basis is adequate but not automatic.** Replying to an inbound message is
unproblematic under POPIA. Two obligations remain: the number must identify
itself as the business, and STOP/opt-out must work on this rail as on the others.

### Accepted risk

Phase 2 places a client's conversations on an unofficial rail. If the number is
flagged mid-week those conversations stop, with no support channel; recovery
means re-pairing a new number and customers seeing a different sender. This is
acceptable for numbers where the relationship is owned directly
(Blitz/Velocity/Cresta). It must not be sold to a third party without that risk
stated in writing — which is why the audience decision was "own numbers now,
product later".

---

## 7. Failure handling

Designed against the failure catalogue in `wa-bridge-ops` rather than against
hypothetical failures.

| Documented failure | Response |
|---|---|
| `LoggedOut` recurring (cold-DM pattern) | **Prevented** by rails 3–6. This is the failure the architecture exists to remove |
| `LoggedOut` single (flagged/unlinked) | Detect, stop accepting sends immediately (do **not** queue — a queue that drains post-repair sends stale messages), alert out-of-band, wait for human re-pair. Never auto-reconnect-loop into a harder block |
| `Client outdated (405)` — forced version bump | Unavoidable on any library. Mitigation is recovery speed: pinned version, scheduled monthly `go get -u go.mau.fi/whatsmeow` + rebuild, and a distinct 405 alert so diagnosis takes minutes rather than the 12 hours the 2026-06-09 incident cost |
| History-sync replay → duplicate sends after restart | Persisted dedup from day one, plus a **replay grace window**: for ~5 min after connect, inbound is recorded but triggers no outbound. The runbook notes replay finishes within ~5 min; this makes that a rule rather than advice |
| Postgres slot exhaustion starving the bridge | **Designed out** — SQLite on local disk, no shared database |
| Tailscale logged out → unreachable DB | **Designed out** — nothing the bridge needs crosses the network |
| 4-device cap / "can't link device right now" | Dedicated number on its own eSIM/handset; device slots not shared with the Cortex or FibreFlow bridges |
| `sendMessage` hangs forever | Per-send timeout → `AMBIGUOUS` outcome, never a blind retry |

The governing pattern: **remove shared dependencies.** Three of the eight
documented outages had nothing to do with WhatsApp — they were a shared Postgres
and a shared network path. This service depends on local disk and the internet.

---

## 8. Session lifecycle

whatsmeow's SQLite store makes restarts transparent. The human procedures need
explicit design:

- **Pairing** — QR rendered by the settings card (phase 2) or terminal (phase 1).
  One documented procedure, not tribal knowledge.
- **Nightly store backup** — `.db` copied off-box. A corrupted store otherwise
  costs a re-pair and the history with it.
- **Re-pair runbook** — written *before* it is needed, because it is needed under
  pressure. The existing `wa-bridge-ops` swap procedure is the template.
- **Number swap** — assumed to happen at least once. No external system stores
  the phone number as an identity key.

---

## 9. Observability

`GET /v1/health` returns: connected, last inbound age, last outbound age,
session age, per-consumer counters, rail-refusal counts by reason, kill state.

**An off-box monitor polls it.** A monitor on the same box dies with the thing it
monitors — already a lesson in `wa-bridge-ops` as "off-box health monitor".

**Alerts route to Bugsink and push, never through WhatsApp.** An alerting path
that runs over the failing transport is not an alerting path.

Three alert conditions:

1. `LoggedOut`.
2. Connected but no inbound for N hours — the silent-failure class that has
   historically cost the most.
3. Rail refusals spiking — a looping consumer, which is the early warning that
   previously arrived as a ban.

---

## 10. Testing

### Named regression tests for real incidents

Every failure in the runbook becomes a test named for it. Each must fail loudly
if the rail is removed — a test that would pass either way is worthless.

- `TestColdDMToNonContactRefused` — the 2026-09-04 +063 pattern: 120 outbounds
  to JIDs with no inbound history, all refused.
- `TestCapsSurviveRestart` — write counters, drop the process, reload, assert the
  cap still binds (encodes the PR #2687 in-memory-dedup bug).
- `TestReplayWindowSuppressesOutbound` — inbound during the post-connect grace
  window records but never sends.
- `TestIdempotentSendReturnsOriginal` — same key twice, one delivery.
- `TestLoggedOutRefusesImmediately` — no queueing behind a dead session.

### Layers

| Layer | Approach |
|---|---|
| Rails | Pure Go unit tests, fake clock, in-memory store |
| Transport | whatsmeow behind a small interface; a fake implements it. Send queue, timeout, dedup, echo suppression testable offline |
| LeadStack client | Vitest against a mocked bridge, mirroring `cloud-client.test.ts`. Includes refusal → `DEFINITELY_REJECTED` and timeout → `AMBIGUOUS` |
| Inbound webhook | Signature verification, replay rejection, tenancy scoping, contact reconciliation |
| End-to-end | Two real numbers, manual, before phase 1 goes live: pairing, restart, re-pair, kill switch, every rail refusal observed |

### Merge gates

**Phase 1 sits inside the Level-3 boundary** — greenfield, not customer-facing,
no live client data, objectively verified by tests that fail when the code is
wrong. Green CI plus an approved blind `/review` suffices.

**Phase 2 sits outside it.** Outbound customer communication touching live client
data keeps a human gate regardless of CI status.

LeadStack changes run `pnpm ci:check`. The bridge runs its own Go pipeline.

---

## 11. Open items

- Confirm the default caps (150/day global, 10/contact/day) against real Blitz
  and Velocity reply volumes before phase 2. They are deliberately conservative
  and are expected to be tuned upward with evidence, never downward from
  optimism.
- Decide the dedicated number's carrier/eSIM and whether it needs a physical
  handset for pairing.
- Confirm `whatsmeow` upstream health at implementation time; the 2026-09-04
  check found it published one day prior.
