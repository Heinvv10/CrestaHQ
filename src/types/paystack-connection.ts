/**
 * Per-sub-account Paystack — the SA card rail.
 *
 * A sub-account connects its OWN Paystack account so it can charge its OWN
 * customers, in ZAR, into its own balance. This is the Paystack analogue of
 * `@/types/payments` (Stripe) and exists because Stripe does not serve South
 * African merchants for payouts, so the Stripe card is unusable for the
 * majority of this deployment's operators.
 *
 * Distinct from Client Billing, which charges the SUB-ACCOUNT on the AGENCY's
 * Paystack via the deployment-wide `PAYSTACK_SECRET_KEY`. Nothing here touches
 * that key.
 *
 * SECRET SPLIT — read this before moving a field:
 *   - `PaystackConnectionSecret` lives at
 *     `subAccounts/{id}/private/paystackConnection`, covered by the generic
 *     `match /private/{docId} { allow read, write: if false }` rule in
 *     firestore.rules (Admin SDK only; no rules deploy needed).
 *   - `PaystackConnectionMeta` lives on the sub-account doc, which ANY active
 *     member can read. Firestore rules are document-level; a field cannot be
 *     hidden from a read that is otherwise allowed. Nothing secret may go in
 *     the meta object — not the key, not a fragment of it beyond the last 4.
 */

/** Doc id of the locked secret doc under `subAccounts/{id}/private`. */
export const PAYSTACK_CONNECTION_DOC_ID = "paystackConnection";

/** Firestore path to the server-only secret. */
export function paystackConnectionSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${PAYSTACK_CONNECTION_DOC_ID}`;
}

/**
 * SERVER ONLY — `subAccounts/{id}/private/paystackConnection`.
 * Never returned by an API route, never sent to a browser.
 *
 * There is no `webhookSecret` sibling to the Stripe shape, and adding one would
 * be a mistake: Paystack signs webhooks with HMAC-SHA512 keyed on this very
 * secret key (see `@/lib/paystack/webhook-signature`). One credential, two
 * jobs.
 */
export interface PaystackConnectionSecret {
  /** Paystack SECRET key — `sk_live_…` / `sk_test_…`. */
  secretKey: string;
}

/**
 * Non-secret display metadata — `SubAccountDoc.paystackConnectionMeta`.
 * Safe for any active member to read.
 */
export interface PaystackConnectionMeta {
  /**
   * WHY THERE IS NO `ready` BOOLEAN HERE.
   *
   * The Stripe card can register a webhook endpoint through the API and so can
   * say, truthfully, "this connection is ready to take money". Paystack cannot:
   * webhook URLs are registered by hand in the Paystack dashboard, with no API
   * to create one and no API to ask whether one exists. A `ready` flag set at
   * connect time would therefore be a guess presented as a fact.
   *
   * The only honest evidence that the dashboard step was done is a webhook that
   * actually arrived and verified. That is this field — null until
   * `/api/webhooks/paystack/sa/{id}` verifies its first signature. The card
   * shows the URL to paste and says plainly that nothing has arrived yet.
   */
  webhookSeenAt: Date | null;
  /** Which URL the operator was told to register, as of connect time. */
  webhookUrl: string | null;
  /** Currencies the account can settle, off `GET /balance`. Display only. */
  currencies: string[];
  /** False for `sk_test_…` — drives the test-mode badge. */
  livemode: boolean;
  /** Last 4 of the secret key, so the operator can tell which key is stored. */
  keyLast4: string | null;
  connectedAt: Date;
}

/**
 * Paystack SECRET key — what must be stored.
 *
 * NOTE the inversion against Stripe: `@/types/payments` REFUSES `sk_…` because
 * Stripe offers restricted keys that can take payments without being able to
 * move money out. Paystack has no restricted-key equivalent — the only two key
 * types are the secret key and the public key — so the secret key is the
 * credential, and refusing it would refuse the integration.
 */
export const PAYSTACK_SECRET_KEY_RE = /^sk_(live|test)_[A-Za-z0-9]+$/;

/** True for `pk_live_…` / `pk_test_…` — the key an operator pastes by mistake. */
export const PAYSTACK_PUBLIC_KEY_RE = /^pk_(live|test)_[A-Za-z0-9]+$/;
