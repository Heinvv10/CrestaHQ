# WhatsApp bridge → product — Statement of Work

**Written 2026-09-05.** Scope for turning the WhatsApp bridge from an internal
rail into a sellable channel, at parity with the unofficial WhatsApp providers
selling into GoHighLevel.

This document is the handover into the next session. It records what was
decided, what is already built and verified, what parity actually requires, and
the order the remaining work should land in.

> **Status as of 2026-09-21. Read this before §1.** §1 ("What is built and verified today") describes
> the code as it stood on 2026-09-05 and is now **out of date**. Since then:
>
> - **WP-A1 to A3 (bridge client, inbound receiver, send path and readiness) are built and live.**
>   The CRM rail landed in #23. Follow-up fixes came in #35, #37, #39, #40 and #42. The `bridge`
>   provider now sends and receives; it no longer just refuses.
> - **WP-A4 (media) is built and live.** Inbound media came in #145, #148 and #151. Outbound media
>   came in #149, with video in #172 and #177. The bridge also carries location messages. It is
>   no longer text-only.
> - **WP-A9 (settings UI):** the per-sub-account WhatsApp settings page came in #94. Self-serve
>   pairing has been proven as far as showing the QR code; the handset scan is unproven.
> - **WP-A5 to A8, A10 and A11** were not re-checked when this note was written. Check `main`
>   before planning any of them.
>
> §0 (decisions) is still in force: the bridge is operated as a service, not sold as software.
> The rest of the document is the 2026-09-05 plan, kept as a record.

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

From a research pass on 2026-09-05, sources listed at the end of this section.
Items marked *unverified* were flagged as such by the researcher and must be
confirmed before anything is built on them.

### Who is actually in this market

| Product | Rail | Price | GHL integration |
|---|---|---|---|
| **LeadConnector** (GHL native) | Official Meta Cloud API | $10/sub-account/mo + per-message credit | First-party channel |
| **WAGHL** | Unofficial, QR | $19–29/sub-account/mo | Rebinds GHL's native **SMS channel** |
| **Wazzap** | Unofficial, QR | $19/sub-account/mo flat, unlimited messages | Two-way sync app |
| **GoGHL** | *unverified* | undisclosed, "no per-message fees" | AI-first, multi-number |
| **WhatsApp Connector** | *unverified* | undisclosed | Custom Conversation Provider |

**The commercial anchor: $19–29 per sub-account per month, flat, unlimited
messages.** That is what we would have to price against, and it is the whole
reason this market exists — GHL's official channel bills per message, and
agencies resell it at $30–100/mo. Unofficial providers sell "unlimited" and
absorb the ban risk in the price.

### What the incumbents do about bans, concretely

- **WAGHL publishes its warm-up policy**: wait **2–3 weeks** after registering a
  number before automating anything, use it normally first. Send pacing is
  built in, not left to the agency: **3–4 seconds between text messages, 6–9
  seconds for media**.
- **WAGHL's re-pair is disconnect-and-rescan, about a minute.** *Self-service
  re-pair is therefore NOT a market gap — I claimed it was in an earlier draft
  of this document and that was wrong.*
- The gap that IS real: **a visible health/ban status dashboard with proactive
  re-pair prompts.** Nobody surveyed clearly demonstrates one, and none of the
  marketing pages disclose what an agency actually sees when a number gets
  flagged. That is the thing already built here.

### The finding that should shape the pool design

The first-hand account of a ban after ~5 messages on a fresh number comes with
a sharper claim: the library has *"no queue, no throttle, no delay"*, banning
decisions happen entirely on WhatsApp's side, and **the only mitigation anyone
cites is number age and history — not any client-side technique.**

If that holds, pacing buys less than it appears to, and **a pool of fresh spare
numbers is close to worthless**: failing over from a dead number to a
day-old one just kills the next number. The pool has to be a pool of *aged*
numbers, which makes warm-up a continuous background activity rather than a
one-off onboarding step, and makes the rented-number option (D4) a real
operational business — you would be selling number age, which is the scarce
thing.

**This is the most important open question in the document. See §9.**

### Sources

marketplace.gohighlevel.com/docs/marketplace-modules/ConversationProviders ·
gohighlevel.com/terms-of-service · waghl.com and waghl.com/faq ·
wazzap.mx/en/gohighlevel and docs.wazzap.mx · goghl.ai ·
help.gohighlevel.com WhatsApp pricing + setup guides ·
artificiallyintimidating.com/p/go-whatsapp-web-multidevice ·
sporesec.com/en/blog/whatsapp-unofficial-api-ban-risk ·
achiya-automation.com/en/blog/whatsapp-spam-detection-2026

*Unverified:* WhatsApp Connector's rail and mechanism; GoGHL's ban-reduction
claims and whether it has a health dashboard; whether Wablas/Interakt have any
real GHL integration beyond generic Zapier-style connectors.

## 3. Parity checklist

Marked against what the unofficial incumbents actually ship.

| Capability | Status today | Class |
|---|---|---|
| QR pairing, self-service, <10 min to first message | **built** | table stakes |
| Self-service re-pair after disconnect | **built** (WAGHL does it in ~1 min — not a gap) | table stakes |
| Multi-number per sub-account | not built | table stakes |
| Inbound → conversation thread, tied to the contact | not wired | table stakes |
| Outbound from the conversation view and from workflows | not wired | table stakes |
| Contact sync / dedup by phone | exists in CRM | table stakes |
| Media: image, video, document, voice note | **not built at all** | table stakes |
| Bulk / broadcast | CRM machinery exists, rail refuses | table stakes |
| Templates | CRM machinery exists, rail refuses | table stakes |
| Workflow / automation sends | CRM machinery exists, rail refuses | table stakes |
| Opt-out / STOP | exists for SMS | table stakes + POPIA |
| **Built-in send pacing as a rail, not agency guidance** | rails exist, not per-tenant or paced | table stakes (WAGHL: 3–4s text, 6–9s media) |
| **Warm-up before automating** | not built | table stakes (WAGHL: 2–3 weeks) |
| Two-way tag sync | partial | expected |
| Pipeline / stage sync | exists in CRM, not wired to this rail | expected |
| Fallback to SMS when a WhatsApp send fails | not built | expected |
| White-label / resellable | exists (CUSTOM_BRAND) | expected |
| Delivery / read receipts | not built | expected — **and no surveyed player advertises it** |
| Typing indicators | not built | expected — same gap |
| Group messaging | not built | differentiator (only Wazzap claims it) |
| Interactive buttons / list messages | not built | differentiator (GoGHL claims it) |
| **Health + ban status dashboard, proactive prompts** | **built today** | **differentiator — the real gap** |
| **Automatic failover to an AGED spare** | not built | **differentiator** |
| Number rental, pre-warmed | not built | differentiator, and see §2 on why age is the product |

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

### WP-A6 · Warm-up and pacing
A number younger than N days is capped on a ramp regardless of configured or
acknowledged caps, and per-message pacing is enforced in the bridge rather than
left to the caller. Both non-negotiable (§5). WAGHL's published figures are the
starting point: 2–3 weeks before automation, 3–4s between texts, 6–9s for
media.
**Done when:** a freshly paired number cannot be made to send above the ramp or
faster than the pacing floor by any setting or tier; the ramp is visible in the
UI with the date it completes; and a caller that submits faster than the pace
is queued rather than refused.

### WP-A7 · Number pool and failover
The manager gains an owner (sub-account) per tenant and a pool per owner: one
active sender, spares in known states. Ban or logged-out detection promotes a
spare and records the swap. Sends address the *pool*, not a number.

**Do not start this before open question 1 in §9 is answered.** If number age
is the only real mitigation, then spares must be AGED to be worth anything, and
this package is really "maintain a set of warm numbers" — a background ageing
process with its own cost — rather than "keep spare rows in a table". Failing
over to a fresh number would just kill the next number, on a schedule.
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
2. **Send pacing has a floor** that no tier lifts. The incumbents build pacing
   in rather than documenting it, and a caller asking to go faster is queued,
   not refused and not obeyed.
3. **Opt-out/STOP is always honoured**, on every tier. POPIA obligation, not a
   throughput setting.
4. **No message bodies in bridge logs.** Bodies live in Firestore where access
   control applies.
5. **The number identifies itself as the business.** POPIA.
6. **Above-ceiling sending requires a recorded acknowledgement** — actor,
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

**There is no WhatsApp provider type in GHL.** Two mechanisms exist and they
are genuinely different builds:

**Option 1 — Custom Conversation Provider (the documented marketplace route).**
`marketplace.gohighlevel.com/docs/marketplace-modules/ConversationProviders`.
Registers as a custom **SMS-type** provider. Requires OAuth scopes
`conversations/message.write`, `conversations.readonly`, `conversations.write`,
`contacts.readonly`, `contacts.write`, `conversations/message.readonly`. You
configure a Delivery URL that receives outbound webhook events signed with
`X-GHL-Signature` (**Ed25519 — must be verified**); inbound goes back through
the Add Inbound Message API. Text plus media attachments are supported.

Three documented limitations that bite this product specifically:
- **Only GHL's own default providers get bulk actions.** A broadcast feature
  cannot ride GHL's bulk machinery — we would have to drive bulk ourselves,
  message by message, through the inbound/outbound APIs.
- The SMS module is unsupported in GHL "premium workflows" on custom SMS
  channels.
- The provider appears as SMS, not as a WhatsApp channel with its own icon.

**Option 2 — SMS-channel impersonation**, which is what WAGHL actually does.
No marketplace app at all: intercept and reroute GHL's native SMS send/receive
so existing SMS automations fire over WhatsApp. Simpler, and it inherits SMS
semantics wholesale, including the confusion of a sub-account user seeing
"SMS" for a WhatsApp conversation.

**Decide between them before scoping anything else** — it changes the auth
model, the webhook surface, whether bulk is possible at all, and what the
customer sees. Neither WhatsApp Connector's nor GoGHL's mechanism could be
verified, so there is no third pattern to copy.

Then: marketplace app and OAuth install, per-sub-account provisioning against
the manager, message mapping including how media survives an SMS-shaped
channel, billing against agencies, and the written risk statement required
before selling to a third party.

**On ToS:** GHL's terms disclaim responsibility for third-party apps — *"use of
any third-party application is at your own risk"* — and require API users to
warrant they have the rights and consents for data they transmit. GHL does not
appear to prohibit unofficial WhatsApp providers outright; it pushes the risk
onto the agency. WhatsApp's own terms **do** prohibit unofficial clients and
bulk auto-messaging. That asymmetry is the business: GHL will not stop us,
Meta will, eventually, per number.

## 9. Open questions for the next session

1. **Is number AGE the only real mitigation?** §2 says the one first-hand
   technical account claims pacing does nothing and only age and history
   matter. If true it reshapes D3 and D4: a pool of fresh spares is worthless,
   warm-up becomes continuous background activity, and the rented-number
   business is really a number-ageing business. **Answer this before building
   WP-A7.** The cheapest test is to age two numbers for three weeks with light
   organic use and compare their survival against one used immediately.
2. **Warm-up N and the ramp shape.** WAGHL publishes 2–3 weeks before any
   automation. Proposal: adopt 21 days, with a ramp that starts at a handful of
   messages a day. Cheap to be conservative here; expensive to be wrong.
3. **Send pacing.** WAGHL uses 3–4s between texts and 6–9s for media, built in
   rather than configurable. Proposal: adopt those as the floor, not settable
   below, even at the acknowledged tier.
4. **The code ceiling** for the two-tier caps (D7). Today's rails are 150/day
   global and 10/contact/day.
5. **Pool size per sub-account**, and where aged numbers come from at the
   rented tier.
6. **May `bridge` be a sub-account's only WhatsApp rail**, or must Twilio/Cloud
   always be configured as a fallback? Note that fallback-to-SMS-on-failure is
   an EXPECTED feature the incumbents ship.
7. **What the customer sees during a failover** — same thread, different sender
   number. Silent, or announced?
8. **Phase B mechanism** (§8), Option 1 vs Option 2.
9. **Pricing.** The market is $19–29/sub-account/month flat and unlimited.
   Ours has to sit against that, and against LeadConnector's $10 + per-message.

## 10. Where the work happens

- Bridge and manager: `services/wa-agent-bridge`, `services/wa-manager` (Go).
- CRM: `src/lib/comms/whatsapp/`, `src/app/api/webhooks/whatsapp/bridge/`,
  `src/components/settings/`, `src/components/contacts/`.
- Deploy: `bash scripts/deploy-wa.sh` from `/home/hein/deploy/CrestaHQ` as
  `hein`. See [[project-wa-deploy-rollout]] in memory.
- Every package: branch, CI green, blind `/review`, merge. The Go services and
  the CRM have separate gates; `pnpm ci:check` covers the CRM.
