# GoHighLevel vs. this codebase — platform decision

**Date:** 2026-09-03 · **Entity:** Brightsphere Technologies (Pty) Ltd t/a CrestaHQ
**GHL agency:** `gZir5Wl7sHyLqqNCmAsi` (Agency Pro, on trial) · 4 live sub-accounts · 22,732 contacts
**Formatted version:** https://claude.ai/code/artifact/f8871121-24cf-46e8-9f92-be7b22fdc646

Checked in the running UI and in the source. Not from marketing pages.

---

## The short version

**Neither platform gives you automated client billing.** Both GHL's SaaS Configurator and this
codebase's Client Billing settle through Stripe, and Stripe does not onboard South African
entities. As Brightsphere Technologies you cannot run SaaS-mode rebilling on either one.

The difference is that here you can change that. On GHL you cannot.

On cost, self-hosting saves roughly **R12,000–14,000/month** at current usage. On features, this
codebase covers most of what CrestaHQ actually uses and misses three things — reputation
management being the one we sell.

---

## Cost

From the live billing page, not the price list. Usage is measured from nine $10 wallet
auto-recharges over six days (28 Aug – 2 Sep) during heavy WhatsApp campaigning — a peak, not a
steady state. FX R17.50/USD.

| Line | Amount |
|---|---|
| GHL Agency Pro plan | $497/mo (trial converts ~11 Sep) |
| GHL add-ons | $69/mo — WhatsApp $40 (4 × $10) + Prospecting $29 |
| GHL usage wallet | ~$450/mo at the observed $15/day burn |
| **GHL total** | **~R17,800/mo** |
| Self-hosted, minimal | R3,120/mo |
| **Self-hosted, realistic** | **R3,780/mo** |
| Self-hosted, all features on | R5,710/mo |

Biggest single self-hosted line is Twilio SA SMS at $0.1355 outbound — not negotiable at our
volume. Firestore is ~R90/mo and only becomes a risk via a write→listener→write loop.

---

## SaaS mode — the blocker, in detail

`src/lib/server/billing-service.ts` calls `stripe.products.create`, `prices.create`,
`checkout.sessions`, `subscriptions.*` — on the **deployment's own** Stripe account. There is no
Stripe Connect anywhere in the billing path. The Client Billing UI states it plainly: "payments
land in your Stripe account."

Stripe does not onboard South African businesses. SA-registered companies cannot create Stripe
Checkout or Connect accounts for ZAR payouts; Stripe's own regional answer is Paystack, and
settlement is restricted to US and EU legal entities.

GHL's SaaS Configurator has the identical requirement — already recorded in the `ghl-agency-ops`
skill: SaaS mode requires Stripe, and Stripe does not onboard SA entities.

**Client Billing here is Stripe-only.** Zero references to Paystack anywhere in `src/`. PayPal
*is* wired (40 references, `src/lib/paypal/payment-link.ts`, settings card, API route) but only
for sub-account → customer invoicing, not agency → sub-account billing.

**There is also no public self-serve signup.** `src/app/api/auth/signup/route.ts` is
bootstrap-then-invite-only, and Client Billing provisions sub-accounts *inside one agency*. This
is not GHL's agency-of-agencies model. Reselling CrestaHQ as SaaS to other agencies is a build,
not a configuration.

---

## Feature parity

Verified against source. "Gated" = code complete and wired, agency switch defaults off.

| Capability | GoHighLevel | This codebase |
|---|---|---|
| Contacts, pipeline, tasks, calendar | Yes | Yes |
| Unified inbox | Yes | SMS + WhatsApp shipped; FB/IG gated, beta |
| WhatsApp | Native (LeadConnector) | Twilio — different rail |
| Workflows / automations | Visual canvas | Builder: 10 triggers, 14 node types |
| AI agents | Paid add-ons ($49/sub-account) | Included — 6 channels |
| Quotes & invoices | Yes | Yes |
| Booking pages | Yes | Yes |
| Email broadcasts | Yes | Gated |
| Bulk SMS broadcasts | Yes | **Absent** — deferred (A2P, consent audit) |
| Reputation management | 8 sub-tabs | **Requests only** |
| Google Business Profile | Live insights on dashboard | **Absent** — hidden "coming soon" |
| Funnel / page builder | Drag-drop | gitpage.site wrapper, 5 sites/client |
| Social planner | Multi-network | Meta only, single image URL |
| Public API + webhooks | Yes | Yes |
| Memberships / courses | Yes | Gated |
| Phone system / call tracking | Yes | **Absent** (Vapi voice ≠ phone system) |
| Mobile app | Native | PWA |
| App marketplace | Yes | **Absent** — ecosystem, not a feature |
| Listings / Yext | Resold | **Absent** |
| Client billing / SaaS mode | Stripe-blocked | Stripe-blocked |

### Scale

182,285 LOC · 1,073 TS/TSX files · 258 API routes · 136 page routes · 297 components.

### Test coverage

**3 test files out of 1,073** — `feedback-token.test.ts`, `rate-limit.test.ts`,
`api/reviews/feedback/route.test.ts`. All written 2026-09-03, all on the reviews module.
Billing, AI agents, comms and workflows have zero automated coverage. CLAUDE.md's
"production-ready" is a documentation claim, not a verified one.

---

## The gap that matters: reputation

CrestaHQ sells review systems at $197–997/mo. Blitz and Velocity are review-request operations.

| GHL Reputation, live today | Here |
|---|---|
| Review requests over Email / SMS / WhatsApp | Yes |
| Reviews inbox — read, rate, respond | No |
| AI review responses + "Drip Response" backlog clearing | No |
| Sentiment analysis + AI recap | No |
| Rating and review-volume trend charts | No |
| Response-coverage tracking | No |
| Video testimonial collector | No |
| Embeddable review widgets + QR scan tracking | No |
| GBP Optimization tab | No |
| Listings distribution to 35+ directories (Yext) | No |

`src/lib/reviews/` is a genuine request engine — three channels, triggers on quote-paid and
deal-completed, 90-day per-contact cooldown, opt-out enforcement, template-approval enforcement
that makes a non-compliant WhatsApp send structurally impossible. It matches row one and nothing
below it.

---

## What GHL resells (the "sell it later" angle)

Agency sets a price, GHL bills and collects, we keep the spread. From the live Reselling page.

| Product | Cost | Client price | Spread |
|---|---|---|---|
| AI Employee — Unlimited | $97/mo | $127/mo | $30 |
| AI Employee — Growth | $50/mo | $75/mo | $25 |
| Listings (Yext, 35+ directories) | $30/mo | $49/mo | $19 |
| Listings — annual | $300/yr | $450/yr | $150 |
| Workflow Pro — Scale | $50/mo | $60/mo | $10 |
| WordPress hosting | $10/site/mo | markup | — |
| WhatsApp | usage | 1x–10x markup | — |
| SEO, Ad Manager, Prospecting, Dedicated IP, Client Portal app | usage | markup | — |

This is the real argument *for* GHL that a cost comparison misses: we are buying a supply chain,
not just software. Self-hosted, each of those becomes a vendor contract plus a billing system.

**Caveat:** the Reselling page states our tier "offers only static markup of 1.05x" and that
configurable markup needs the $497 plan — so today the spread on most of this is nominal.

---

## Two findings to act on regardless

### 1. Blitz has an unanswered-review backlog

**3.97★ across 134 reviews** (confirmed on screen). GHL's response-coverage panel reports roughly
**31 unresponded**, sentiment around 78% positive. GHL's "Drip Response" exists to clear exactly
this backlog.

The exact AI-vs-manual split and the average response time were below the fold and are **not
verified** — two audit passes returned different numbers. Read them yourself before quoting any of
it to a client.

### 2. The billing and reselling pages disagree about our plan

Settings → Billing: **Agency Pro, $497/mo, on trial**.
Reselling page: **$297 plan**, "static markup of 1.05x… upgrade to $497 Plan".

Both read live on 2026-09-03. Resolve before the trial converts — it changes the bill *and*
whether we can set custom resale markups.

---

## If we build

| Phase | Estimate | Blocked? |
|---|---|---|
| GBP connection (OAuth, location picker, review URL) | 2–3 d | No — port from `ApexGEO/src/lib/business-profile/oauth.ts` |
| Review monitoring (poll, store, alert, chart) | 3–4 d | **Yes** — Business Profile API v4 needs Google quota approval |
| Review responding (`reviews.updateReply` + AI draft) | 2 d | **Yes** — same approval |
| Paystack billing rail (replaces Stripe in Client Billing) | 3–5 d | No |
| Bulk SMS + GHL opportunities/notes import | 4–6 d | Needs a GHL Private Integration Token |

Three to four weeks to run CrestaHQ on its own platform with the product we sell intact. At
R12,000/mo saved that pays back inside two months — **if** the Google approval lands, which is
outside our control. See `docs/GBP_API_QUOTA_REQUEST.md`; the clock has not started.

About 70% of monitoring is deliverable now via the Places API, which is already enabled on
`crestahq-app`.

---

## Risks the cost model doesn't show

- **Test coverage is effectively zero** outside the reviews module.
- **On-call becomes ours.** Firebase Blaze has no default spending ceiling — set a budget alert.
- **Blast radius.** One Twilio suspension takes SMS, WhatsApp and voice down across every client
  at once. GHL spreads that across thousands of tenants.
- **WABA quality-tier reset.** Moving `+27 78 435 6159` off LeadConnector throttles us to ~1,000
  unique conversations per 24h — during the exact weeks we'd be proving the move worked.
- **Two external approvals gate real features** — Google for review monitoring, Meta App Review
  for the FB/IG inbox and posting. Neither is schedulable.
- **A lapsed client's API keys keep working.** Billing status and `apiAccessEnabledByAgency` are
  independent gates, so "no pay, no access" is not enforced on `/api/v1/*`.

---

## Recommendation

**Move CrestaHQ's own workspace first. Leave the clients on GHL.**

3,163 contacts, no customer-facing risk, and it forces us to live with the gaps before a client
does. Build GBP and the review loop while it runs. Submit the Google quota request now — that
clock is the long pole.

Keep Blitz, Velocity, Vortex and Appliances Repairs on GHL until the review product is
demonstrably equal — and "equal" now means more than monitoring and replying. GHL runs live GBP
insights, AI review responses, sentiment analysis and Yext distribution on those accounts today.

**The Agency Pro trial converts around 11 September.** Downgrade to Unlimited on the *last* day —
doing it earlier ends the trial immediately and charges sooner.

---

## Method and limits

**Verified:** full source audit (182,285 LOC, 258 routes) plus the running app; the live CrestaHQ
GHL account — billing page, reselling page, both navigation trees, sub-account settings,
Reputation overview; and workflow step definitions pulled from Firebase Storage via each
workflow's `fileUrl`, since GHL's REST export returns metadata only.

**Not verified:**
- GHL SaaS Configurator and Add-Ons pages would not render headless (blank after 55s, twice each).
  SaaS-mode terms come from prior operational notes.
- Only Blitz was walked in depth as the representative sub-account.
- Build estimates are mine and unvalidated against anyone else working in this codebase.
- The self-hosted cost is a model at R17.50/USD, not an invoice.
- The review response-coverage breakdown (AI vs manual, average response time) — two audit passes
  disagreed.
