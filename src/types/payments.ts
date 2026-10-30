/**
 * Payments v1 — the sub-account card rail.
 *
 * A sub-account connects its OWN Stripe account so it can charge its OWN
 * customers. Money lands in the client's Stripe and never touches the agency's
 * balance. Distinct from Client Billing (agency → sub-account, the deployment's
 * `STRIPE_SECRET_KEY`) and from the agency's own subscription.
 *
 * v1 is "Tier 1" — the operator pastes a Stripe RESTRICTED key. Tier 2
 * (Stripe Connect) is NOT built, but the shape below keeps the seam: under
 * direct charges both tiers issue identical API calls to the same Stripe
 * account, so switching is one branch inside `getSubAccountStripe()`.
 *
 * SECRET SPLIT — read this before moving a field:
 *   - `StripeConnectionSecret` lives at `subAccounts/{id}/private/stripeConnection`
 *     with `allow read, write: if false` (Admin SDK only).
 *   - `StripeConnectionMeta` lives on the sub-account doc, which ANY active
 *     member can read (firestore.rules — member read on `subAccounts/{id}`).
 *     Firestore rules are document-level; a field cannot be hidden from a read
 *     that is otherwise allowed. Nothing secret may go in the meta object.
 */

/** Doc id of the locked secret doc under `subAccounts/{id}/private`. */
export const STRIPE_CONNECTION_DOC_ID = "stripeConnection";

/** Firestore path to the server-only secret. */
export function stripeConnectionSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${STRIPE_CONNECTION_DOC_ID}`;
}

/**
 * SERVER ONLY — `subAccounts/{id}/private/stripeConnection`.
 * Never returned by an API route, never sent to a browser.
 */
export type StripeConnectionSecret =
  | {
      mode: "key";
      /** Stripe restricted key — `rk_live_…` / `rk_test_…`. */
      restrictedKey: string;
      /**
       * Signing secret for the webhook endpoint registered on the client's
       * account. Empty string while awaiting a manual paste (the fallback when
       * the restricted key lacks Webhook Endpoints write).
       */
      webhookSecret: string;
    }
  | {
      /** Tier 2 — not built in v1. Present so the union can't be widened later
       *  without every consumer being forced to handle it. */
      mode: "connect";
      connectedAccountId: string;
    };

/**
 * Non-secret display metadata — `SubAccountDoc.stripeConnectionMeta`.
 * Safe for any active member to read.
 */
export interface StripeConnectionMeta {
  /** Absent on legacy docs — read as "key". */
  mode: "key" | "connect";
  /** False while a manual webhook secret is still outstanding. Checkout must
   *  refuse to run until this is true, or payments would succeed with no way
   *  to hear about it. */
  ready: boolean;
  /** `acct_…`, display only. Null when the key lacks Account read. */
  accountId: string | null;
  /** Business name off the Stripe account, for the settings card. */
  accountName: string | null;
  /** False for `rk_test_…` — drives the test-mode badge. */
  livemode: boolean;
  /** Last 4 of the restricted key, so the operator can tell which key is stored. */
  keyLast4: string | null;
  connectedAt: Date;
}

/** Restricted-key prefixes. A full secret key (`sk_…`) is refused on save. */
export const RESTRICTED_KEY_RE = /^rk_(live|test)_[A-Za-z0-9]+$/;

/** True for `sk_live_…` / `sk_test_…` — used to give a targeted error. */
export const SECRET_KEY_RE = /^sk_(live|test)_[A-Za-z0-9]+$/;

/**
 * Stripe events the client's account must send us. Registered automatically
 * when the restricted key permits it; otherwise shown to the operator for
 * manual endpoint creation.
 */
export const SUB_ACCOUNT_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  // Closes an express buy-link order that was never paid. Endpoints
  // registered before this was added don't send it; their orders stay pending.
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
] as const;
