# WhatsApp provider seam — Phase 1.2

**Date:** 2026-09-03 · Scopes task 1.2 of [PARITY_PLAN.md](PARITY_PLAN.md).
Grilled and locked before any code was written.

## What this is

WhatsApp becomes a **provider-agnostic channel** with three arms selected per
sub-account. Today's Twilio path stays the default and is untouched in
behaviour; Meta Cloud API lands alongside it; an unofficial bridge follows as
1.2b.

| Provider | Rail | Templates | 24h window | Status |
|---|---|---|---|---|
| `twilio` | Twilio Content API (BSP) | yes | enforced | **default, shipped** |
| `cloud` | Meta Graph direct | yes | enforced | **this phase** |
| `bridge` | unofficial (Baileys-class) | **no** | **not enforced by Meta** | 1.2b — interface only |

`ndzinga-lms` already runs this shape (`resolveProvider("WHATSAPP", tenantId)`
dispatching `WA_CLOUD` / `WA_UNOFFICIAL` behind one `WaResult`). We are adding a
third arm to a proven design, not inventing one.

## Why a seam rather than a replacement

The WABA cutover throttles the sending number to ~1,000 unique
conversations/24h for the weeks we are proving the move. If Cloud were the only
rail that cutover is all-or-nothing and untestable. With a seam, cutover is one
field per sub-account, reversible in seconds, and Velocity can stay on
LeadConnector while CrestaHQ's own workspace proves the path.

## Locked decisions

### 1. Providers declare capabilities

```ts
interface WhatsAppProviderCapabilities {
  supportsTemplates: boolean
  enforcesWindow: boolean
}
```

The bridge has neither. Declaring this **now** means adding the bridge arm later
cannot silently turn every "outside window — needs template" refusal into a
free-form send. Retrofitting that guard after the fact is how a number gets
banned.

### 2. The send-mode rule is pure and shared

Ported near-verbatim from `ndzinga-lms/lib/whatsapp/send-mode.ts`:

- inside the window → free-form text
- outside + an approved template → template
- outside + no approved template → refuse **before any HTTP call**

This is the rule worth ~$87/mo (PARITY_PLAN §0.3): it makes "send free-form when
the window is open" structural rather than a workflow convention someone can
undo. CrestaHQ has window logic today, but only in the manual send route, where
it *refuses* instead of falling back to a template.

### 3. Template approval is per-provider

Templates belong to a **WABA**. Cloud runs against our own WABA, so a template
approved through Twilio's BSP is not approved on the Cloud rail. `contentSid` +
`status` + `rejectionReason` + `pollAttempts` + `approvedAt` move off the doc
root into:

```ts
registrations: {
  twilio?: { externalId, status, rejectionReason, pollAttempts, approvedAt }
  cloud?:  { externalId, status, rejectionReason, pollAttempts, approvedAt }
}
```

One logical template, one definition, per-rail approval state.
`hasApprovedTemplate` becomes "approved **on the provider we are about to send
through**" — the only question the send path ever asks. The bridge registers
nothing.

Legacy docs (flat `contentSid`/`status`) read as a `twilio` registration, so no
migration is required.

### 4. Same Meta app, isolated credentials

Signature verification reuses `META_APP_SECRET` and the existing verifier in
`src/lib/comms/meta.ts` — already built and tested for the Messenger/IG inbox.

WABA credentials (`wabaId`, `phoneNumberId`, `accessToken`) go in
`subAccounts/{id}/private/whatsappCloudConnection` — Admin-SDK only, covered by
the generic default-deny `private/{docId}` rule, matching Payments v1 and
Webinar1.

**This is a deliberate correction, not a copy of the local pattern.**
`subAccounts/{id}` is readable by every active member, so today's
`twilioConfig.authToken` and `metaConfig.pageAccessToken` are visible to any
collaborator. A WABA system-user token is worth more than either — it sends
messages billed to us and manages templates. One reader function
(`getWabaCreds`) isolates it so encryption-at-rest can be added later without
touching a single call site.

The webhook is its own route (`/api/webhooks/whatsapp-cloud`) — payload shape
and routing key differ from Messenger/IG — but shares the verifier.

## Acceptance criteria — what "done" means

Against CrestaHQ's own sub-account and a test WABA:

1. Inbound WhatsApp → contact reconciled → `whatsappMessages` row →
   conversation index → AI reply dispatched, identical to the Twilio path.
2. Free-form send succeeds **inside** the window; the same send falls back to an
   approved template **outside** it, and refuses cleanly when no approved
   template exists.
3. Flipping `whatsappProvider` back to `twilio` restores today's behaviour
   exactly.

## Explicitly NOT in this phase

Bridge implementation · Velocity/Blitz cutover · WABA number migration ·
template re-submission UI · WhatsApp broadcast and workflow nodes.

## Known risk

The seam is only truly provable against a live test WABA. Everything below that
line is mock-tested — the same trap already flagged for
`PaystackBillingProvider`. Mock-green is not evidence the rail works.
