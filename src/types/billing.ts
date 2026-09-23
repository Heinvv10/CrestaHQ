import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Client Billing v1 — agency → sub-account plans + paywall.
 *
 * The agency owner defines PLANS (a monthly price + a bundle of the existing
 * per-sub-account feature gates), assigns a plan to a sub-account, and the
 * client pays through the deployment's own Stripe account (one agency per
 * deployment — no Stripe Connect). Payment state lives on
 * `SubAccountDoc.billing`; plan docs live at `agencies/{agencyId}/plans`.
 *
 * Money is stored in integer cents (like `products.unitPriceCents`).
 */

/**
 * The feature gates a plan can bundle. Mirrors the agency Manage-dialog
 * gate set MINUS Get Leads (parked — see GET_LEADS_PARKED). Assigning /
 * activating a plan writes EXACTLY these fields on the sub-account doc,
 * so a plan is the single source of truth for a managed client's gates.
 * The `*HiddenWhenDisabled` presentation overrides are deliberately NOT
 * plan-managed — they stay manual.
 */
export const PLAN_GATE_KEYS = [
  "emailDomainEnabledByAgency",
  "apiAccessEnabledByAgency",
  "broadcastsEnabledByAgency",
  "outboundVoiceEnabledByAgency",
  "whatsappEnabledByAgency",
  "smsAgentEnabledByAgency",
  "webChatEnabledByAgency",
  "inboundVoiceEnabledByAgency",
  "metaInboxEnabledByAgency",
  "metaAgentEnabledByAgency",
  "websiteEnabledByAgency",
  "socialPlannerEnabledByAgency",
  "communityEnabledByAgency",
  "missedCallTextBackEnabledByAgency",
  "aiSuiteEnabledByAgency",
  "labsEnabledByAgency",
  "reviewsAiEnabledByAgency",
] as const;

export type PlanGateKey = (typeof PLAN_GATE_KEYS)[number];

/** Human labels for the plan configurator + manage dialog. */
export const PLAN_GATE_LABELS: Record<PlanGateKey, string> = {
  emailDomainEnabledByAgency: "Dedicated email sending domain",
  apiAccessEnabledByAgency: "Public API access",
  broadcastsEnabledByAgency: "Email broadcasts",
  outboundVoiceEnabledByAgency: "Outbound AI voice calls",
  whatsappEnabledByAgency: "WhatsApp channel",
  smsAgentEnabledByAgency: "SMS AI auto-reply",
  webChatEnabledByAgency: "Web Chat AI",
  inboundVoiceEnabledByAgency: "Inbound Voice AI",
  metaInboxEnabledByAgency: "Facebook + Instagram inbox",
  metaAgentEnabledByAgency: "Messenger & Instagram AI auto-reply",
  websiteEnabledByAgency: "Website builder",
  socialPlannerEnabledByAgency: "Social Planner",
  communityEnabledByAgency: "Community + Courses",
  missedCallTextBackEnabledByAgency: "Missed Call Text Back",
  aiSuiteEnabledByAgency: "AI Suite assistant",
  labsEnabledByAgency: "Labs (pre-release features)",
  reviewsAiEnabledByAgency: "Reviews AI (sentiment and reply drafts)",
};

/** Full gate bundle a plan carries — every key present, true = enabled. */
export type PlanGates = Record<PlanGateKey, boolean>;

/**
 * Billing cadence. A plan always has a monthly price and MAY also offer an
 * annual price; the agency picks the cadence when it assigns the plan to a
 * sub-account. Maps 1:1 to Stripe's `recurring.interval`.
 */
export type BillingInterval = "month" | "year";

export type BillingPlanStatus = "active" | "archived";

/**
 * One agency-defined subscription plan. Lives at
 * `agencies/{agencyId}/plans/{planId}` — server-only writes (Admin SDK via
 * /api/agency/plans); reads go through the same API, no client rules needed.
 *
 * Stripe linkage: creating a plan creates a Product + a recurring monthly
 * Price on the deployment's Stripe account. Editing the price creates a NEW
 * Stripe Price (prices are immutable) and deactivates the old one — existing
 * subscriptions stay on the price they signed up at.
 */
export interface BillingPlanDoc {
  id: string;
  agencyId: string;
  /** Display name, 1–60 chars (e.g. "Starter", "Pro"). */
  name: string;
  /** Optional short pitch shown to the agency (≤300 chars). */
  description: string | null;
  /** Monthly price in integer cents. Stripe minimum (~50¢) enforced at create. */
  priceMonthlyCents: number;
  /**
   * OPTIONAL annual price in integer cents. `null` = the plan is monthly-only.
   * When set, a second Stripe Price (interval=year) is minted on the same
   * Product; the agency chooses monthly vs annual at assignment. The agency
   * types the annual amount directly (e.g. 10× monthly for "2 months free") —
   * no auto-computed discount.
   */
  priceAnnualCents: number | null;
  /** Lowercase ISO 4217 (e.g. "usd", "aud"). Fixed after creation. */
  currency: string;
  gates: PlanGates;
  /**
   * Optional per-month usage quotas included with the plan (see
   * USAGE_METERING_V1_PLAN.md). Null/absent = unlimited. Enforcement
   * reads the plan doc live (cached), so quota edits apply to subscribed
   * workspaces without a re-apply pass. Overridable per workspace via
   * `SubAccountDoc.usageQuotas`.
   */
  quotas?: import("./usage").UsageQuotas | null;
  /**
   * Overage sell rates (cents) for usage beyond `quotas` — see
   * UsageRates. Display/accrual only in v1.5; the automatic monthly
   * overage charge is the v2 job.
   */
  rates?: import("./usage").UsageRates | null;
  status: BillingPlanStatus;
  stripeProductId: string | null;
  stripePriceId: string | null;
  /** The interval=year Stripe Price. `null` when the plan is monthly-only. */
  stripeAnnualPriceId: string | null;
  createdAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

/** Wire shape returned by /api/agency/plans (timestamps → ISO strings). */
export interface BillingPlanResponse {
  id: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  /** OPTIONAL annual price in cents; null = monthly-only. */
  priceAnnualCents: number | null;
  currency: string;
  gates: PlanGates;
  quotas?: import("./usage").UsageQuotas | null;
  rates?: import("./usage").UsageRates | null;
  status: BillingPlanStatus;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Billing lifecycle of one sub-account:
 *   - "comped"    — not billed through the platform (the default for every
 *                   sub-account, including all pre-feature legacy docs, which
 *                   simply have no `billing` field). Gates stay manual.
 *   - "pending"   — a plan is assigned but the client hasn't paid yet. The
 *                   workspace shows an activation paywall to sub-account
 *                   members until checkout completes.
 *   - "active"    — paying subscription in good standing.
 *   - "past_due"  — a renewal failed. Members see a dunning banner while
 *                   `graceUntil` is in the future, then the hard paywall.
 *   - "canceled"  — subscription ended (Stripe cancel or dunning exhausted).
 *                   Hard paywall; data preserved; re-checkout reactivates.
 */
export type SubAccountBillingStatus =
  | "comped"
  | "pending"
  | "active"
  | "past_due"
  | "canceled";

/**
 * Per-sub-account billing state, stored at `SubAccountDoc.billing`.
 * Server-only writes (the subAccounts rules already deny all client writes);
 * readable by members like the rest of the doc so the paywall + settings
 * card can render without extra reads.
 */
export interface SubAccountBilling {
  status: SubAccountBillingStatus;
  planId: string | null;
  /** Denormalized for list UIs — refreshed on assign/activate. */
  planName: string | null;
  /**
   * Effective charge in cents for the chosen `billingInterval` (special price
   * wins over plan price). For an annual subscription this is the yearly
   * amount — divide by 12 for an MRR roll-up.
   */
  priceCents: number | null;
  /**
   * The billing cadence the sub-account is on. `null` for comped / legacy docs
   * (treated as monthly for display). Stamped at assignment alongside the
   * interval-correct `stripePriceId`.
   */
  billingInterval: BillingInterval | null;
  currency: string | null;
  /** Per-client override; null = plan's standard price. */
  specialPriceCents: number | null;
  /**
   * The Stripe Price the checkout / subscription uses — the plan's standard
   * price or a one-off special price minted for this sub-account. Stamped at
   * assignment so /pay doesn't re-resolve the plan.
   */
  stripePriceId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /**
   * SHA-256 of the currently-valid checkout-link token (raw token only ever
   * lives in the emailed/copied URL — same discipline as quote tokens).
   * Rotated on every "send/copy link"; null once consumed by activation.
   */
  checkoutTokenHash: string | null;
  /**
   * End of the dunning grace window, stamped when the subscription first
   * goes past_due. Checked at request/render time (no cron): past_due +
   * graceUntil in the past = hard paywall. Cleared on recovery.
   */
  graceUntil: Timestamp | FieldValue | Date | null;
  assignedAt: Timestamp | FieldValue | Date | null;
  activatedAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

/** Days of dunning grace after a renewal fails before the hard paywall. */
export const BILLING_GRACE_DAYS = 7;

// ---------------------------------------------------------------------------
// One-time charges (agency → sub-account client, e.g. "Web design — $500")
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a one-time charge:
 *   - "pending"  — created; the tokenized /pay/charge link is live.
 *   - "paid"     — Stripe checkout completed (webhook-confirmed).
 *   - "canceled" — the agency voided it; the link is dead.
 */
export type BillingChargeStatus = "pending" | "paid" | "canceled";

/**
 * One ad-hoc charge, stored at top-level `billingCharges/{id}` (server-only
 * writes via the billing service; reads through the owner-only API — no
 * client rules). Distinct from PLANS (recurring subscriptions) and from the
 * sub-account's own Quotes/Invoices (them billing THEIR customers): this is
 * the agency charging its client one time through the deployment's Stripe,
 * via `mode: "payment"` Checkout with ad-hoc price_data (no Stripe Product).
 */
export interface BillingChargeDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  /** What the client sees on the Stripe checkout line, 1–120 chars. */
  description: string;
  amountCents: number;
  /** Lowercase ISO 4217. */
  currency: string;
  status: BillingChargeStatus;
  /**
   * SHA-256 of the currently-valid /pay/charge token (raw token only ever
   * lives in the emailed/copied URL — same discipline as plan checkout
   * links). Rotated on re-send; null once paid or canceled.
   */
  tokenHash: string | null;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  /** Checkouts that paid this charge AGAIN after it was paid — each one is a
   *  refund the agency owes. Absent/empty on a normal charge. */
  extraPaymentRefs?: string[];
  createdByUid: string;
  createdAt: Timestamp | FieldValue | Date | null;
  paidAt: Timestamp | FieldValue | Date | null;
  updatedAt: Timestamp | FieldValue | Date | null;
}

/** Wire shape returned by the charges API (timestamps → ISO strings). */
export interface BillingChargeResponse {
  id: string;
  subAccountId: string;
  description: string;
  amountCents: number;
  currency: string;
  status: BillingChargeStatus;
  createdAt: string | null;
  paidAt: string | null;
  /** Times it was paid again after being paid (see `extraPaymentRefs`). */
  extraPaymentCount: number;
}
