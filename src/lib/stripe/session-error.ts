import "server-only";

import Stripe from "stripe";

/**
 * Shared error mapper for the public "create a Stripe Checkout Session" routes
 * (invoice pay, booking deposit, community purchase, checkout page).
 *
 * Two audiences, two messages:
 *  - the BUYER gets something honest and non-technical; they can't fix the
 *    operator's Stripe configuration and shouldn't see its internals.
 *  - the LOG gets Stripe's own type/code/message, because the generic
 *    "temporarily unavailable" string is undiagnosable on its own — which is
 *    exactly how the first live failure was hit.
 *
 * The permission branch matters most: a RESTRICTED key that can't write
 * Prices/Products fails here and nowhere else, since inline `price_data`
 * creates those objects on the fly. That's a setup problem with an exact fix,
 * so it gets its own message rather than being lumped in with outages.
 */

export interface MappedSessionError {
  /** Safe to show a customer. */
  buyerMessage: string;
  /** Structured detail for server logs. */
  logDetail: string;
  status: number;
  /** True when the operator must change their restricted-key scopes. */
  isPermission: boolean;
}

export function mapStripeSessionError(err: unknown): MappedSessionError {
  if (err instanceof Stripe.errors.StripeError) {
    const detail = `type=${err.type} code=${err.code ?? "-"} status=${
      err.statusCode ?? "-"
    } message=${err.message}`;

    if (err.type === "StripePermissionError") {
      return {
        buyerMessage:
          "Card payment isn't fully set up on this account yet. Please contact the sender.",
        logDetail:
          `RESTRICTED KEY MISSING PERMISSIONS — creating a Checkout Session with inline ` +
          `price_data also creates a Price and a Product, so the key needs WRITE on ` +
          `Prices and Products (not just read), plus write on Checkout Sessions. ` +
          `Update the key in Stripe → Developers → API keys, then reconnect under ` +
          `Settings → Payments. Stripe said: ${detail}`,
        status: 503,
        isPermission: true,
      };
    }

    if (err.type === "StripeAuthenticationError") {
      return {
        buyerMessage:
          "Card payment isn't available right now. Please contact the sender.",
        logDetail: `Stripe rejected the stored restricted key (revoked or rotated?). ${detail}`,
        status: 503,
        isPermission: true,
      };
    }

    return {
      buyerMessage: "Card payment is temporarily unavailable.",
      logDetail: detail,
      status: 502,
      isPermission: false,
    };
  }

  return {
    buyerMessage: "Card payment is temporarily unavailable.",
    logDetail: err instanceof Error ? err.message : String(err),
    status: 502,
    isPermission: false,
  };
}
