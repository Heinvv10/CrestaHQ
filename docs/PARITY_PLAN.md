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
- **Template-category policy.** Marketing-class WhatsApp costs **5× utility**. On GHL that
  classification is buried in their template UI; here it is ours to enforce in code.
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
| 0.3 | **WhatsApp template-category audit** | ~half day | Up to **~$73/mo**, on GHL, no migration | Hein + Claude |
| 0.4 | **Trial decision** — Unlimited $297 converts in ~7 days | 5 min | Avoid a surprise charge | Hein |

**0.1 must precede 0.2.** The quota application asserts we do not gate reviews. Four live
branches currently do. Submitting first risks a rejection that is slow to appeal and blocks
Phase 3 entirely. Paste-ready fixes: [REVIEW_GATING_FIX.md](REVIEW_GATING_FIX.md).

**0.3 detail.** August: 2,290 marketing messages cost **$91.13 (64% of the entire bill)**; 6,082
utility cost $48.53. `ndzinga-lms/lib/whatsapp/template-submit.ts` already codifies "register as
UTILITY" as deliberate cost policy — CrestaHQ does not. Audit every active template, identify
transactional follow-ups misclassified as marketing, resubmit as UTILITY.
**Caveat: Meta assigns the final category, not us.** A "leave us a Google review" ask reads as
marketing; a "how did the installation go?" check-in has a genuine utility argument. This is a
test, not a certainty — cheap and reversible either way.

---

## Phase 1 — Control. 1–2 weeks. Nothing external gates this.

| # | Task | Effort | Notes |
|---|---|---|---|
| 1.1 | **Paystack rail** replacing Stripe in Client Billing | 3–5 d | `src/lib/stripe/sub-account-client.ts:148` is an explicit single seam — its own comment says swapping is "a one-line change here rather than a sweep" |
| 1.2 | **Meta Cloud API port** from `ndzinga-lms` | 2–3 d | Not a build. See table below |
| 1.3 | **Recurring / automated invoicing** | 3–4 d | Genuinely absent here too — only Stripe subscriptions in `billing-service.ts`. Do not assume we inherit it |
| 1.4 | **Test suite on billing + comms** | 3–4 d | 3 test files in 1,073. Feature parity without test parity means the first client migration finds the bugs |

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
- Meta refuses UTILITY reclassification for the review flow → Phase 0.3 is worth ~$0; the cost
  case weakens further.
- WABA quality tier drops below Medium after cutover → roll back to LeadConnector.
- Phase 1 runs past 3 weeks → we were wrong that these were ports, not builds.

## Open questions

1. Do Vortex and Appliances Repairs use GHL reputation, or only the request engine? Decides
   whether they can migrate before Phase 3.
2. Verify Meta's published ZA rate card against the measured $0.039795 / $0.007979 before
   treating "no markup" as settled.
3. Who owns the GHL Private Integration Token for Phase 2?
