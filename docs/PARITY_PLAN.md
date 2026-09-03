# CrestaHQ parity plan — what we build, in what order, and why

**Date:** 2026-09-03 · Supersedes the sequencing in [GHL_VS_LEADSTACK.md](GHL_VS_LEADSTACK.md),
whose corrections block should be read first.

## The premise, restated

We are **not** doing this to save money. The measured GHL bill is **R8,880/mo** (not R17,780),
and the usage markup we assumed we were paying is **~nil** — August was 98.8% WhatsApp at
approximately Meta passthrough rates. A full migration saves roughly R5,100/mo gross, less once
we pay Meta ourselves.

We are doing it for **control**:

- **Paystack.** Stripe permanently blocks SA entities from SaaS-mode rebilling. GHL cannot fix
  this for us — ever. Here it is one seam.
- **Send-path policy.** Marketing templates cost **5× utility and infinitely more than a
  free-form message inside an open service window**. GHL leaves that choice to whoever built the
  workflow; `ndzinga-lms` already enforces it in code (template mode only when the window is
  closed). See 0.3 — it is worth 62% of the wallet bill.
- **Invoicing automation** GHL does not offer.
- **Not being repriced underneath us** — "Ask AI, AI Studio, and Managed Agents are now
  chargeable" appeared as a banner, not a negotiation.

## Sequencing principle

**Cheapest reversible wins first. Externally-gated work starts its clock immediately but is
built last.** Reputation — the thing we sell — is the *worst* thing to lead with, because it is
the only item 100% dependent on an approval we do not control and have never obtained.

---

## Phase 0 — This week. No code, no approvals, immediate value.

| # | Task | Effort | Value | Owner |
|---|---|---|---|---|
| 0.1 | **Fix the 4 review-gating branches** | ~1 h | Compliance. Google actively enforces since Apr 2026 | Hein (GHL UI) |
| 0.2 | **Submit the Google BPA v4 quota request** | ~1 h | Starts the only clock we cannot compress | Hein |
| 0.3 | ~~Template-category audit~~ **Send review asks in-window as free-form** | ~half day | **~$87/mo — 62% of the wallet bill**, on GHL, no migration | Hein + Claude |
| 0.4 | **Trial decision** — Unlimited $297 converts in ~7 days | 5 min | Avoid a surprise charge | Hein |

**0.1 must precede 0.2.** The quota application asserts we do not gate reviews. Four live
branches currently do. Submitting first risks a rejection that is slow to appeal and blocks
Phase 3 entirely. Paste-ready fixes: [REVIEW_GATING_FIX.md](REVIEW_GATING_FIX.md).

**0.3 detail — REVISED after audit 2026-09-03.** The original hypothesis (templates misclassified
as marketing) is **wrong**. Velocity's templates are correctly classified: `experience_check_v2`
is Utility, the review asks are Marketing, and Meta would rightly reject a "leave us a Google
review" template as Utility.

**The real finding is larger.** We are paying $0.040/msg for messages that should cost **$0.00**.

The flow is: `velocity_experience_check_v2` (Utility, $0.008) is sent business-initiated → the
customer taps a button ("Happy & connected") → **that tap opens a 24-hour service window** → and
the review ask is then sent as `velocity_review_request_v2`, a **Marketing template at $0.040**,
in the same minute. Inside an open service window a free-form message is **free** — GHL's own
ledger confirms it: 1,802 service messages billed at $0.00.

| | Marketing msgs (Aug) | Cost | Sent free-form in-window |
|---|---:|---:|---:|
| Velocity Fibre | 1,586 | $63.11 | $0.00 |
| Blitz Fibre | 615 | $24.47 | $0.00 |
| **Total** | **2,201** | **$87.58/mo** | **~$0** |

**62% of the entire wallet bill**, recovered by changing *when* the message is sent, not what it
says. Cost: the tappable "Leave a review" button is lost (free-form messages cannot carry
buttons) — a plain URL does the same job.

Not all 2,201 are post-tap; the reminder and cold-request templates legitimately need template
sends because their window is closed. Scope the fix to the post-button review ask, which is the
dominant path.

`ndzinga-lms/lib/whatsapp-cloud.ts` already implements this decision — template mode **only** when
the window is closed. Porting it (task 1.2) makes the saving structural rather than a workflow
convention someone can undo.

### August spend by sub-account (measured)

| Sub-account | Aug 2026 | Marketing msgs | Utility msgs |
|---|---:|---:|---:|
| Velocity Fibre | $83.01 | 1,586 | 2,454 |
| Blitz Fibre | $54.59 | 615 | 3,628 |
| CrestaHQ | $2.29 | — | — |
| Vortex Media | $1.38 | — | — |
| Appliances Repairs JHB | $0.03 | — | — |

Answers open question 1: **Vortex, Appliances Repairs and CrestaHQ together spend $3.70/mo.** They
are cheap to migrate and cheap to leave. All meaningful usage is Velocity + Blitz — the two
review operations, which are also the two gated on Google.

GHL also bills **"Reviews AI" at $0.010/use** (105 events in Aug across both) — a line we would
own outright post-migration.

---

## Phase 1 — Control. 1–2 weeks. Nothing external gates this.

| # | Task | Effort | Notes |
|---|---|---|---|
| 1.1 | **Paystack rail** replacing Stripe in Client Billing | **5–8 d** (revised) | **NOT a one-line seam — that was an error.** See 1.1 detail |
| 1.2 | **Meta Cloud API port** from `ndzinga-lms` | 2–3 d | Not a build. See table below |
| 1.3 | **Recurring / automated invoicing** | 3–4 d | Genuinely absent here too — only Stripe subscriptions in `billing-service.ts`. Do not assume we inherit it |
| 1.4 | **Test suite on billing + comms** | 3–4 d | 3 test files in 1,073. Feature parity without test parity means the first client migration finds the bugs |

### 1.1 detail — CORRECTED 2026-09-03

The plan originally cited `src/lib/stripe/sub-account-client.ts:148` as "an explicit single seam".
**That is the wrong surface.** There are two independent Stripe integrations:

| | Surface | Client | Whose money |
|---|---|---|---|
| **Payments v1** | sub-account → its own customers | `sub-account-client.ts` (the sub-account's own restricted key) | the client's |
| **Client Billing** | agency → sub-account | `getStripeServer()` (the deployment's key) | ours |

Paystack must replace the **second**. That one has no single seam — seven files touch it
(`billing-service.ts`, `stripe/server.ts`, `checkout.ts`, `portal.ts`, `webhooks.ts`,
`api/webhooks/stripe/route.ts`, `billing/portal/route.ts`) with ~17 direct `stripe.*` calls in
`billing-service.ts` alone: `products.create`, `prices.create` (×4), `checkout.sessions.create`,
`subscriptions.retrieve/update`, `customers.create`, `billingPortal.sessions.create`.

**Approach: a `BillingProvider` interface**, with `StripeBillingProvider` wrapping today's
behaviour exactly and `PaystackBillingProvider` alongside it. Not a find-and-replace. The Stripe
adapter lands first as a pure refactor with no behaviour change — that is independently valuable
(it is also the seam that makes 1.4's billing tests possible) and unblocks everything else.

**Three semantic gaps that are product decisions, not code:**

1. **No proration.** Stripe's `subscriptions.update` prorates a mid-cycle plan switch. Paystack
   has no equivalent — you disable the subscription and create a new one. Plan switching changes
   behaviour.
2. **No hosted billing portal.** The dunning banner's "Update card" opens Stripe's portal.
   Paystack offers only an email-token `manage_link`. Weaker, and a different UX.
3. ~~**Currency.** Existing plan docs carry `currency` and the pricing is USD.~~ **RESOLVED
   2026-09-03 — clean slate.** Firestore has **0 plan docs, 0 billingEvents, and all 4
   sub-accounts comped** (no `billing` field at all); `STRIPE_SECRET_KEY` is not even set on this
   deployment. Client Billing has never been used, so ZAR needs **no migration path** and no
   immutable-Price reconciliation on live subscribers. Decide ZAR and move.

**Prerequisite:** a live Paystack account for Brightsphere Technologies. The interface and the
Stripe adapter can be built without it; the Paystack adapter cannot be verified without it.

### 1.2 — what already exists in `ndzinga-lms`

| Piece | File |
|---|---|
| Direct Graph send | `lib/whatsapp-cloud.ts:96` → `graph.facebook.com/{v}/{phoneNumberId}/messages` |
| 24h-window logic forcing template mode | `lib/whatsapp-cloud.ts` |
| APPROVED-only template enforcement | `hasApprovedTemplate` guard |
| Template submission direct to Meta | `lib/whatsapp/graph-templates.ts` → `createWabaTemplate` |
| Inbound webhook + `hub.verify_token` | `app/api/webhooks/whatsapp-cloud/route.ts` |
| `X-Hub-Signature-256` verification | `verifyWaba` + `writeWebhookSignatureFailure` |
| Delivery-status ingestion | `parseWabaStatuses` / `applyWabaStatuses` |
| Tests | 197 lines on the cloud module + config tests |

This **removes the Twilio Content API dependency**, not just the send path. Critical: routing
WhatsApp through Twilio would cost roughly **$50/mo MORE** than GHL (Meta rate + Twilio fee).
Only Cloud API direct makes self-hosting cheaper.

⚠️ **WABA quality-tier reset.** Moving `+27 78 435 6159` off LeadConnector throttles us to
~1,000 unique conversations/24h during exactly the weeks we are proving the move works. Plan the
cutover for a low-volume window.

---

## Phase 2 — Migrate our own workspace. 1 week.

CrestaHQ's own 3,163 contacts. No customer-facing risk, and it forces us to live with the gaps
before a client does. The GHL import is **already built** — contacts, opportunities→deals, notes,
custom fields, pipeline stage mapping, chunked resumable jobs, wizard UI (`src/lib/import/ghl/`).
Needs a GHL Private Integration Token.

Also here: **bulk SMS** (2–3 d) — the one genuinely missing broadcast channel.

---

## Phase 3 — Reputation. Gated on Google. Build only once approved.

| # | Task | Effort |
|---|---|---|
| 3.1 | GBP OAuth + location picker | 1–2 d |
| 3.2 | Review monitoring (poll, store, alert, chart) | 2–3 d |
| 3.3 | Review replying + AI draft responses | 2 d |

**`ApexGEO/src/lib/business-profile/` is far more complete than "port the OAuth file" implies:**
`google-gateway.ts` has `listReviews` (v4, paginated, `totalReviewCount`), `updateReply` (v4 PUT),
localPosts, plus `repository.ts` (18KB), `service.ts` (13KB), token refresh, retention, and **5
test files**. It sits behind `APEX_GOOGLE_BUSINESS_PROFILE_ENABLED` awaiting the same approval.

**Do not attempt a Places API interim.** Tested live 2026-09-03: Places caps at **5 reviews**, no
pagination, **no reply field**. It yields a rating/volume trend chart and nothing else.

### Scope the pilot to one location

Blitz is **two listings**: Gqeberha **4.9★ / 15 reviews**, Pretoria **3.9★ / 118**. GHL's "3.97★
across 134" sums them. The backlog and the rating problem are entirely Pretoria — one location is
enough to prove the product.

---

## What we are explicitly NOT building

App marketplace · Yext/listings distribution · native mobile app · phone system / call tracking ·
multi-network social. These are ecosystem and supply chain, not features. Resell or accept.

---

## Kill criteria

Stop and reassess if any of these hold:

- Google rejects the v4 quota request, or is silent past **60 days** → Phase 3 is dead; re-decide
  whether Phases 0–2 alone justify leaving GHL (they may, on control grounds).
- ~~Meta refuses UTILITY reclassification~~ **Resolved: categories are already correct.** New risk:
  if the post-tap review ask cannot be sent free-form in GHL's workflow builder (template-only
  node), 0.3 is worth ~$0 until the Meta Cloud API port lands.
- WABA quality tier drops below Medium after cutover → roll back to LeadConnector.
- Phase 1 runs past 3 weeks → we were wrong that these were ports, not builds.

## Open questions

1. ~~Do Vortex/Appliances use GHL reputation?~~ **Partly answered:** they spend $1.41/mo combined,
   so nothing meaningful runs there. Still confirm no reputation dependency before migrating them.
2. Verify Meta's published ZA rate card against the measured $0.039795 / $0.007979 before
   treating "no markup" as settled.
3. Who owns the GHL Private Integration Token for Phase 2?
4. **Firestore has 4 sub-accounts; GHL has 5.** Missing locally: *Appliances Repairs JHB*
   ($0.03/mo, so low stakes). Close the gap before Phase 2 rather than discovering it mid-import.
