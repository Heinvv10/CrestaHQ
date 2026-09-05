# WhatsApp bridge → product — Statement of Work

**Written 2026-09-05.** Scope for turning the WhatsApp bridge from an internal
rail into a sellable channel, at parity with the unofficial WhatsApp providers
selling into GoHighLevel.

This document is the handover into the next session. It records what was
decided, what is already built and verified, what parity actually requires, and
the order the remaining work should land in.

---

## 0. Decisions taken

All six were taken by Hein on 2026-09-05 in a grill session. Three reverse
standing decisions in
[the rail design spec](2026-09-04-whatsapp-bridge-rail-design.md); those are
marked **REVERSAL** and the consequence is stated rather than argued.

| # | Decision | Consequence |
|---|---|---|
| D1 | **Both products, LeadStack first, GoHighLevel next** | Phase A wires the bridge into this CRM; Phase B sells the same bridge as a channel inside other people's GHL sub-accounts. |
| D2 | **REVERSAL — full parity: bulk, templates and automation on the unofficial rail** | Spec §6 says "no templates, no broadcasts, no workflow sends on this rail — ever … these are exactly the bulk outbound patterns that killed +063". That constraint is lifted. Expect bans; §6 of this document says what that looks like. |
| D3 | **Number pool with automatic failover** | Several numbers per sub-account, one active sender, warm-up on new ones, automatic failover when the active number dies. The single largest work package. |
| D4 | **Numbers: customer-supplied by default, rented option** | Customer brings a SIM and pairs it. A paid "rent a warmed number" option exists for customers who cannot. |
| D5 | **v1 done = the full parity feature set** | Conversations, bulk, templates, automation, pool + failover, analytics. No thin slice; see §7 for how it is sequenced so it is still reviewable. |
| D6 | **REVERSAL — sub-account admins self-serve** | Spec §6 says "selecting `bridge` is agency-owner-only … must be a deliberate agency decision". Now any sub-account admin may enable the rail and tune caps. Ban and legal exposure moves to people who may not read the warning, which is why the recorded risk acknowledgement in §5 is a hard requirement, not a checkbox. |
| D7 | **Two-tier caps** | Self-service caps under a code ceiling; exceeding the ceiling requires an explicit recorded acknowledgement, after which caps are advisory. Proposed by me and adopted; overturn it here if it is wrong. |

**Proving ground: Blitz Fibre** — a number and customer base Hein owns, with real
inbound volume, where the consequence of a ban lands on him and can be watched
daily.

---

## 1. What is built and verified today

Everything in this section was exercised against the running system on
2026-09-05, not read off a plan.

**`services/wa-agent-bridge`** — one process per WhatsApp number.
Session persistence across restarts (soak-proven: reconnect with no re-pair, no
stale message forwarded). Safety rails enforced in code: kill switch,
per-consumer budget, reply-only, per-contact cap, consecutive cap, daily cap,
quiet hours, idempotency. Health endpoint reporting connection, kill state,
24h volume, allowlist count, and — as of today — the paired number and the
build version, both only to an authenticated caller.

**`services/wa-manager`** — provisions and supervises bridges.
Tenant CRUD, port allocation, pairing QR, restart, health polling and
reconciliation, an operator screen, and a fleet rollout that restarts stale
bridges one per minute inside an overnight window, holding on the first
casualty.

**Deployment** — `scripts/deploy-wa.sh`, merged and used for real today.
Artifact-hash versioning, so a redeploy of unchanged source restarts zero
numbers (verified in production).

**In the CRM** — a `bridge` provider value exists in
`src/lib/comms/whatsapp/send-dispatch.ts` and `readiness.ts` and does exactly
one thing: refuses with *"The WhatsApp bridge provider isn't available yet."*

### What is NOT built, and is often assumed to be

- **The bridge is text-only.** `wa.Transport.Send(ctx, jid, text)`. No images,
  documents, audio, voice notes or location, inbound or outbound. Every
  competitor ships media; this is a real work package, not wiring.
- **No delivery or read receipts**, no typing indicators, no group support.
- **Caps are process-level config**, not per-tenant and not settable at runtime.
- **The manager has no concept of a sub-account**, a number pool, warm-up, or
  failover. Tenants are opaque ids with no owner.
- **Nothing in the CRM can reach the bridge.** No client, no credentials, no
  inbound webhook receiver, no settings UI.

---

## 2. Market baseline

From a research pass on 2026-09-05. Items marked *unverified* were flagged as
such by the researcher and must be confirmed before they are relied on.

- **GHL's own WhatsApp (LeadConnector)** is the official Meta Cloud API, about
  $10 per sub-account plus per-message billing. That is the safe incumbent we
  are *not* competing with on safety.
- **The unofficial competitors** — WAGHL, Wazzap, GoGHL — all use
  whatsmeow/Baileys-style QR pairing, the same class of client as ours.
- **There is no native WhatsApp provider type in the GHL marketplace.**
  Competitors integrate either through the documented Custom Conversation
  Provider mechanism, which supports SMS/Email/Call types only, or by simply
  impersonating the SMS channel — which is what WAGHL does. **Phase B is
  therefore "WhatsApp wearing an SMS costume", with the constraints that
  implies.** Confirm the exact mechanism against GHL's docs before building.
- **Anti-ban engineering is table stakes, not a differentiator.** Warm-up
  periods, send pacing and number-age heuristics are shipped by every
  unofficial player. One first-hand account, on a whatsmeow bridge structurally
  identical to ours, reported a ban **after roughly five messages from a fresh
  number**.
- **A visible health/ban dashboard with self-service re-pairing is a documented
  gap.** None of the surveyed competitors clearly ships one. This is the one
  place where what we already built is ahead of the market rather than behind
  it.

*Unverified and not to be relied on:* WhatsApp Connector's official/unofficial
status and integration mechanism; GoGHL's ban-reduction claims; whether
Wablas/Interakt have any real GHL-specific integration.

---

## 3. Parity checklist

Marked against what the unofficial incumbents ship.

| Capability | Status today | Class |
|---|---|---|
| QR pairing, self-service | **built** (manager UI) | table stakes |
| Multi-number per account | not built | table stakes |
| Inbound → CRM conversation thread | not wired | table stakes |
| Outbound from the CRM | not wired | table stakes |
| Media: image, document, audio, voice note | **not built at all** | table stakes |
| Bulk / broadcast | CRM machinery exists, rail refuses | table stakes |
| Templates | CRM machinery exists, rail refuses | table stakes |
| Workflow / automation sends | CRM machinery exists, rail refuses | table stakes |
| Contact sync, tags | exists in CRM | table stakes |
| Opt-out / STOP | exists for SMS (`lib/comms/sms-consent.ts`) | table stakes, and a POPIA obligation |
| Warm-up ramp on new numbers | not built | table stakes (see the five-message account) |
| Send pacing | rails exist, not per-tenant | table stakes |
| Delivery / read receipts | not built | expected |
| Typing indicators | not built | expected |
| Team inbox | exists in CRM | expected |
| Analytics / reporting | not built for this rail | expected |
| Group messaging | not built | expected |
| **Health + ban dashboard** | **built today** | **differentiator** |
| **Self-service re-pair after a ban** | **built today** | **differentiator** |
| **Automatic failover to a spare number** | not built | **differentiator** |
| Number rental (warmed) | not built | differentiator |

---

## 4. Phase A — LeadStack, end to end

Work packages. Each is a PR with its own blind review; each states what must be
true, and how that is proven. "Proven" never means a passing unit test alone —
this rail's failures are all integration failures.

### WP-A1 · Bridge client and credentials in the CRM
`bridge-client.ts` mirroring `cloud-client.ts`; credentials at
`subAccounts/{id}/private/whatsappBridge`, Admin SDK only. Rail refusal maps to
`DEFINITELY_REJECTED`, timeout to `AMBIGUOUS`.
**Done when:** a unit test proves each refusal code maps to the right delivery
verdict, and a manual send from a scratch sub-account reaches a real handset.

### WP-A2 · Inbound receiver
`api/webhooks/whatsapp/bridge/[subAccountId]`, HMAC-verified, reusing
`verifyWebhookSignature` and added to `PUBLIC_PATH_PATTERNS`. Writes to
`contacts/{id}/whatsappMessages` — the subcollection the Twilio rail already
uses, so the thread UI, unified inbox, `upsertConversationForMessage`,
`message.received` and push all work unchanged.
**Done when:** a message sent from a real phone appears in the LeadStack thread
within seconds, and an unknown sender auto-creates a contact phone-first.

### WP-A3 · Send path and readiness
Replace the two "not available yet" refusals with a real send and a
configured-and-connected check.
**Done when:** a human replies from the LeadStack thread and it arrives on the
handset. **This is the first genuine end-to-end moment and should be
demonstrated on Blitz before anything below is started.**

### WP-A4 · Media
New: bridge transport gains typed send/receive for image, document, audio and
voice note; storage of inbound media; size and MIME limits; thumbnails in the
thread. `Send(ctx, jid, text)` becomes a message-shaped argument.
**Done when:** each media type round-trips both directions against a real
handset, and an oversized or unsupported type is refused with a message a human
can act on.

### WP-A5 · Per-tenant caps, two-tier
Caps move from process config to per-tenant state, settable through the manager
API and the CRM settings UI. A code ceiling above the settable range. Exceeding
it requires the recorded acknowledgement in §5, after which caps are advisory.
**Done when:** a cap change takes effect without a restart; the ceiling cannot
be exceeded through any UI path; and the acknowledgement is written with actor
and timestamp before the first above-ceiling send is permitted.

### WP-A6 · Warm-up
A number younger than N days is capped on a ramp regardless of configured or
acknowledged caps. Non-negotiable (§5).
**Done when:** a freshly paired number cannot be made to send above the ramp by
any setting, and the ramp is visible in the UI with the date it completes.

### WP-A7 · Number pool and failover
The manager gains an owner (sub-account) per tenant and a pool per owner: one
active sender, spares in known states. Ban or logged-out detection promotes a
spare and records the swap. Sends address the *pool*, not a number.
**Done when:** killing the active number's session causes the next send to go
from the spare without operator action, the swap is on the operator screen and
in the sub-account's own view, and no message is lost or duplicated across the
swap.

### WP-A8 · Bulk, templates and automation on the rail
Lift the app-layer refusals: broadcast audiences, workflow `send_whatsapp`
steps and template dispatch may resolve to `bridge`. Reuses the existing
broadcast audience and step/send machinery.
**Done when:** a broadcast to a test audience sends at the configured pace,
opt-outs are excluded before dispatch, replies thread back to the right
contact, and a mid-broadcast kill-switch trip stops it.

### WP-A9 · Settings and health UI in the CRM
The sub-account-facing surface: connect/disconnect, pairing QR, pool state,
per-number health, caps, warm-up progress, kill switch, and the risk
acknowledgement.
**Done when:** a non-technical sub-account admin completes pairing, sends,
survives a simulated ban and re-pairs, without help and without the operator
screen.

### WP-A10 · Analytics
Sent, delivered, failed, refused-by-rail with reasons, per number and per
campaign.
**Done when:** the numbers reconcile against the bridge's own counters.

### WP-A11 · The Blitz proof
A real inbound, a real human reply, then one real broadcast from a warmed
number with opt-out honoured.
**Done when:** it has run against real Blitz customers and been observed for a
week without a ban attributable to the rail.

---

## 5. Non-negotiable, whatever the settings say

These do not move for parity, for a customer request, or for a demo. They are
the difference between an aggressive product and an irresponsible one.

1. **Warm-up applies to every number younger than N days.** No setting, tier or
   acknowledgement lifts it. A fresh number is the one that dies at five
   messages.
2. **Opt-out/STOP is always honoured**, on every tier. POPIA obligation, not a
   throughput setting.
3. **No message bodies in bridge logs.** Bodies live in Firestore where access
   control applies.
4. **The number identifies itself as the business.** POPIA.
5. **Above-ceiling sending requires a recorded acknowledgement** — actor,
   timestamp, and the text they were shown. This is what carries the position
   that the customer chose the risk, now that sub-account admins can enable the
   rail themselves (D6).

---

## 6. Risk, and the expected failure mode

Stated plainly because D2 and D6 were deliberate reversals.

**Numbers will be banned.** Not as a tail risk — as normal operation. The
evidence is first-hand and specific: a structurally identical bridge lost a
fresh number after about five messages, and this project has already lost +063
to exactly the bulk pattern D2 re-enables. The design response is warm-up, a
pool, and fast failover; none of it makes bans rare, it makes them survivable.

**Consequences worth naming before they happen:**

- A banned number is gone. Conversations on it stop, and customers see a
  different sender when the spare takes over.
- With D6, a sub-account admin can enable this rail without the agency owner
  knowing. The acknowledgement record is the only artefact showing they were
  told.
- Phase B puts this on numbers belonging to strangers, in their GHL accounts.
  The rail design spec's warning — *"must not be sold to a third party without
  that risk stated in writing"* — is now a contractual requirement, not a
  design note.
- Meta's stance on unofficial multi-device clients does not improve over time.
  A protocol change can take the whole fleet down at once; the rollout built
  today is what makes recovery a scheduled operation rather than a scramble.

---

## 7. Sequencing

WP-A1 → A2 → A3 is the critical path to the first real end-to-end moment and
should not be parallelised. Demonstrate A3 on Blitz before starting anything
else — everything below assumes the rail works, and if it does not, that
assumption is cheaper to break early.

```
A1 ─▶ A2 ─▶ A3 ═══ PROVE ON BLITZ ═══▶ ┬─▶ A4 media
                                        ├─▶ A5 caps ─▶ A6 warm-up ─▶ A7 pool
                                        └─▶ A9 settings UI
                        A5+A6+A7 ─▶ A8 bulk ─▶ A10 analytics ─▶ A11 Blitz proof
```

A8 must not start before A6. Turning on bulk without warm-up is the
five-message failure, on purpose.

---

## 8. Phase B — the GoHighLevel channel

Scoped, not specified. Do not start until Phase A is proven on Blitz.

- Confirm the integration mechanism against GHL's documentation: Custom
  Conversation Provider (SMS/Email/Call types only) versus SMS-channel
  impersonation. This decision constrains everything else and the research on
  it is not yet verified.
- Marketplace app, OAuth install, per-sub-account provisioning against the
  manager.
- Message mapping in both directions, including how media survives a channel
  that is nominally SMS.
- Billing against agencies, and support for numbers we do not own.
- The written risk statement required before selling to a third party.

---

## 9. Open questions for the next session

1. **N for warm-up, and the ramp shape.** Needs a number. The five-message
   account suggests the first days should be very slow.
2. **The code ceiling.** What is the number no setting may exceed? Today's
   rails are 150/day global and 10/contact/day.
3. **Pool size per sub-account** at the rented tier, and where rented numbers
   come from.
4. **Whether `bridge` may become a sub-account's *only* WhatsApp rail**, or
   must always have Twilio/Cloud configured as a fallback.
5. **What the customer sees during a failover** — same thread, different
   sender number. Silent, or announced?
6. GHL integration mechanism (§8) — verify before scoping Phase B.

---

## 10. Where the work happens

- Bridge and manager: `services/wa-agent-bridge`, `services/wa-manager` (Go).
- CRM: `src/lib/comms/whatsapp/`, `src/app/api/webhooks/whatsapp/bridge/`,
  `src/components/settings/`, `src/components/contacts/`.
- Deploy: `bash scripts/deploy-wa.sh` from `/home/hein/deploy/CrestaHQ` as
  `hein`. See [[project-wa-deploy-rollout]] in memory.
- Every package: branch, CI green, blind `/review`, merge. The Go services and
  the CRM have separate gates; `pnpm ci:check` covers the CRM.
