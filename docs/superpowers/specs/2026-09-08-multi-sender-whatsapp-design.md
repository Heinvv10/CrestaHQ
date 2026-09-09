# Multiple WhatsApp numbers per sub-account — design

**Status:** specced, not built. Grilled 2026-09-08; the four rulings below are
decisions, not suggestions.

## Why

A sub-account can name several senders today — `WhatsAppSender` already carries
its own `provider`, so the rail is per number, not per workspace. What it cannot
do is give them different **credentials**: every rail reads exactly one document
per sub-account (`subAccounts/{id}/private/whatsappBridge`, and the cloud
equivalent). `WhatsAppSender.credentialsId` was reserved for this and
`resolveWhatsappSender` refuses a sender that carries one rather than silently
sending on another sender's credentials — a fail-closed guard written before the
feature, which this design lifts deliberately.

So today you get one bridge number and one WABA number per client. The goal is
several of each.

The bridge side is already there: wa-manager provisions one systemd instance per
tenant with its own port and paired number, and tenant ids are arbitrary strings.
The constraint is entirely CrestaHQ's credential path.

## Rulings

**1. The bridge carries automation, human replies and AI — bounded by an
opener budget per sender, not by a rail-wide prohibition.**

This REVERSES [`2026-09-04-whatsapp-bridge-rail-design.md`](2026-09-04-whatsapp-bridge-rail-design.md),
which says "no templates, no broadcasts, no workflow sends on this rail — ever"
and "autonomous customer sends are out of scope". Nothing in code enforced that
— `humanReply` only relaxes quiet hours — so workflow sends already reach the
bridge. **That document must be corrected in the same PR as the first code
change.** A spec saying "ever" while the code does the opposite is worse than no
spec, because the next reader trusts it.

But the evidence behind the old line stands and must be designed around, not
waved past. From that same document, confirmed 2026-09-04:

> `+063` logged out 12× in one window. Individual DMs to people who never
> messaged the number, ~120/day, "matches Meta's bot/spam heuristics exactly.
> Group send_ack path is NOT the trigger — individual DMs are." The same number,
> same library, ran group acks for months without incident and was banned within
> days of cold DMs. **"The ban signal is behavioural, not transport-level."**

The axis is therefore NOT rail-vs-rail. It is **openers per day per number**. A
bridge number opening five conversations a day is indistinguishable from a
person; one opening 8,383 is dead within days. Automation *inside* a
conversation the customer started — AI replies, everything downstream of
`wait_for_reply`, human replies — satisfies reply-only and is naturally
bounded. Only the OPENER is dangerous.

So openers become a per-sender property:

- Every sender declares whether it may open a conversation, and at what daily
  rate.
- Cloud and Twilio default to unlimited — Meta meters and polices them.
- Bridge senders default to **reply-only**. Enabling openers is a deliberate
  agency-owner action, and the rate cannot exceed the rail's own ceiling
  (rails #3 and #8 in the bridge design: per-consumer budget, global 150/day).
- A workflow whose opener would exceed the sender's budget FAILS with the
  reason. It does not silently burn the number.

The bridge already implements the enforcement (rail #5 reply-only, #3 budget,
#8 cap); this exposes it per sender rather than per deployment. **CrestaHQ's
setting must correspond to the bridge's config, never replace it** — the app
layer refuses early with a clear message, the rail refuses authoritatively.

Practical consequence for the review flows as built: Blitz's 8,383 contacts
cannot open on a bridge number at any safe rate, so those openers want a WABA
sender. A client doing twenty installs a week can run the entire flow on one
bridge number. The setting decides it per client, which is the point.

**2. Conversations pin to the number they started on.**

A send whose sender is dead FAILS, loudly, with the sender named. It does not
fall back to another number. A customer mid-conversation about a fibre fault who
receives the next message from a different number reads it as a scam — brand
damage to a client, not a technical wrinkle.

Recovery is an explicit operator action: reassign a conversation to a live
sender, one click, visible. Stranded conversations with no path back are equally
unacceptable; the escape hatch is human, not silent.

**3. wa-manager is authoritative for bridge numbers. It pushes; CrestaHQ caches.**

Two registries for one fact will drift, and the failure is a message sent from
the wrong identity to a real customer. wa-manager learns the number from the
pairing itself (`Tenant.Phone`, "filled once paired") — ground truth from
WhatsApp rather than something an operator typed.

wa-manager already gives each consumer its own token and webhook URL, so number
state pushes over the same channel inbound messages already use. Push, not pull:
it works co-located today, works over the network when the service is sold to
other users, works per-buyer in a SaaS shape, and keeps wa-manager off the send
path so a restart cannot fail a customer send. **No mode flag** — one topology
that is correct in every deployment.

Consequence: for `provider: "bridge"` senders, `phoneNumber` becomes read-only
in CrestaHQ and is synced. `label` and `isDefault` stay operator-owned. Cloud and
Twilio senders keep the hand-entered path; there is no equivalent authority for
them.

**4. One AI persona per sub-account. The number is context, not configuration.**

The persona stays at `subAccounts/{id}/aiAgent/profile`. The resolved agent
context gains the sender, so a prompt can say "if this is the support line…".
This is a field, not a second document — it avoids multiplying the config
surface, the settings UI and the snapshot payload before there is evidence a
shared persona is too blunt.

Holds only while several numbers are different FUNCTIONS of one brand. Different
brands in one workspace would need real per-number personas; that is a different
design.

## Forced consequences

- **wa-manager tenant ids stop being sub-account ids.** The live instance is
  `wa-agent-bridge@xmbepgknjiqyygstfsnw`; a second Blitz number collides on the
  instance name. Tenant ids become independent, and the sub-account becomes an
  attribute of a tenant.
- **The bridge inbound payload change is ADDITIVE.** Hermes consumes the same
  bridge; removing or renaming a field takes Cortex ingestion down with it.

## The gap this closes

Inbound cannot currently tell two numbers apart. The payload is
`{from, text, messageId, at}` — no `to`, no instance id
(`webhooks/whatsapp/bridge/[subAccountId]/route.ts:60-65`) — and the route fills
`to` from `subAccount.whatsappBridgeMeta.displayPhoneNumber`, a single field
(`route.ts:338`). With two numbers on one client, **every inbound message is
attributed to whichever number happens to be stored.** Neither `conversations`
nor `whatsappMessages` carries a `senderId` at all.

## Work, in order

Each phase ships behind green CI and a blind review, and each is useful alone.

### Phase 1 — inbound knows which number it hit

1. `services/wa-agent-bridge`: include the instance's own identity in the
   webhook payload (`to` + `instanceId`), additive.
2. CrestaHQ inbound route: read them, resolve to a registry sender, stamp
   `senderId` on the message and the conversation. Fall back to today's
   behaviour when absent, so an un-upgraded bridge keeps working.
3. `conversations` + `whatsappMessages` gain `senderId` (optional; absent on
   every existing doc, which is why readers must tolerate null).

*Ships value alone:* correct attribution in the inbox even with one number.

### Phase 2 — per-sender credentials

4. `whatsappBridgeSecretPath(subAccountId, senderId?)` →
   `private/whatsappBridge__<senderId>`, falling back to the current path when
   `senderId` is absent. Same shape for cloud. **Existing workspaces must not
   need a migration** — the fallback is the migration.
5. `resolveWhatsappSender` stops refusing `credentialsId`.
6. Thread the resolved sender through `dispatchWhatsappSend` and
   `checkWhatsappReadiness` to the credential read. Today
   `WhatsappDispatchInput` has no `senderId` and the resolver always picks the
   default (`resolve-sender.ts:96-98`).

### Phase 3 — choosing a sender

7. `send_whatsapp` node config gains optional `senderId`, defaulting to the
   registry default. Builder shows a picker — parity with GHL's
   "SELECT FROM PHONE NUMBER", which is what motivated the registry.
8. Workflow steps that name a dead sender fail with the sender named, per
   ruling 2.

### Phase 4 — wa-manager as the authority

9. wa-manager pushes tenant state (paired, number changed, logged out, banned)
   to each consumer's webhook URL.
10. CrestaHQ syncs `phoneNumber` for bridge senders and marks a sender
    unhealthy when wa-manager says so; `phoneNumber` becomes read-only for that
    rail.
11. Operator action: reassign a conversation to a live sender.

## Out of scope

- Automatic failover between numbers (ruling 2).
- Per-number AI personas (ruling 4).
- Multiple numbers on Twilio — no per-sender credential story there, and no
  demand.
- Warm-up schedules for a new number. Operational, not code — though the
  opener budget in ruling 1 is where a warm-up would be expressed.
- Any change to template approval: it is per rail and per WABA, and the bridge
  has no templates.

## Acceptance

Each is a test that fails when the behaviour is broken, not a description.

- Two bridge senders on one sub-account, messages inbound to each, and each
  conversation carries the right `senderId`. **Mutation:** drop the payload's
  `to` and the attribution must fall back, not guess wrong.
- A send naming sender B uses B's credentials, never A's. **Mutation:** ignore
  `senderId` in the credential read and this must go red.
- A workspace with no `senderId` anywhere behaves exactly as today — the
  fallback path is what protects the live Blitz number.
- A send on a dead sender fails with the sender named, and no message is
  delivered from a different number.
- A workflow step naming a deleted sender fails rather than sending on the
  default.
- An opener on a reply-only bridge sender is refused BEFORE dispatch, naming
  the sender and the setting. **Mutation:** remove the check and the send must
  reach the rail's own refusal rather than succeeding — the two guards are
  belt and braces, and the test proves both exist.
- An opener that would exceed the sender's daily budget is refused, and the
  count is per sender rather than per sub-account.

## Risks

- **Live number.** Blitz's bridge number is paired and carrying real
  conversations. Phase 2's fallback is what keeps it working; test that path
  before the credential change, not after.
- **Two-repo change.** Phase 1 spans CrestaHQ and `services/wa-agent-bridge`,
  and the bridge is also consumed by Hermes. Additive only.
- **Ban risk is now the product's problem**, not a caveat. +063 is the proof it
  is not theoretical. Ruling 1 bounds it with a per-sender opener budget rather
  than a prohibition, which means a misconfigured client can still burn a
  number — the default (reply-only) is what carries the safety, so it must not
  drift to permissive for convenience.
- **Several numbers multiply exposure** rather than spread it: they are
  traceable to one operation. Spreading volume across numbers to evade a
  ceiling is the pattern the ceiling exists to stop.
