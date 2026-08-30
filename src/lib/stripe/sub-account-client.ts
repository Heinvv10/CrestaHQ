import "server-only";

import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { getStripeServer } from "@/lib/stripe/server";
import {
  stripeConnectionSecretPath,
  type StripeConnectionSecret,
} from "@/types/payments";

/**
 * THE Tier 1 / Tier 2 seam. Every Stripe call made on behalf of a SUB-ACCOUNT
 * (its own customers paying it) must be constructed here — never
 * `new Stripe(key)` inline in a route.
 *
 * Why this matters: under direct charges, Tier 1 (the sub-account's own
 * restricted key) and Tier 2 (Stripe Connect) issue IDENTICAL API calls to the
 * SAME Stripe account. Only the client construction differs:
 *
 *   Tier 1   new Stripe(restrictedKey).checkout.sessions.create({ ...body })
 *   Tier 2   platformStripe.checkout.sessions.create({ ...body }, { stripeAccount })
 *
 * So adding Connect later is one branch in this one function, and the checkout
 * service / order bumps / reconciler above it never change. Bypass this and
 * that property is lost.
 *
 * It is also the ONLY code path that reads `restrictedKey`, which keeps the
 * secret boundary and the tier seam in the same chokepoint.
 *
 * NOTE: this is NOT `getStripeServer()`. That one is the AGENCY's own Stripe
 * (founders checkout, Client Billing, disputes) — a different account, a
 * different purpose, a different key.
 */

export class StripeConnectionError extends Error {
  readonly code: "not_connected" | "not_ready" | "unsupported_mode";

  constructor(
    code: "not_connected" | "not_ready" | "unsupported_mode",
    message: string,
  ) {
    super(message);
    this.name = "StripeConnectionError";
    this.code = code;
  }
}

export interface SubAccountStripe {
  stripe: Stripe;
  /**
   * Per-request options, or `undefined` in key mode.
   *
   * DO NOT pass this straight through as a second argument when it's
   * undefined/empty. stripe-node decides whether a trailing object is an
   * options bag by looking for KNOWN option keys (`stripeAccount`, `apiKey`,
   * `idempotencyKey`, …); an empty `{}` matches none of them, so the SDK
   * treats it as an unexpected extra argument and throws
   * "Unknown arguments ([object Object])" before the request is even sent.
   *
   * Use `createCheckoutSessionForSubAccount()` (below) rather than wiring this
   * up per call site.
   */
  opts: Stripe.RequestOptions | undefined;
  mode: "key" | "connect";
  /** Verify inbound webhooks from THIS sub-account's account. Empty in connect
   *  mode (Connect webhooks verify against the platform's secret instead). */
  webhookSecret: string;
}

/** Read the server-only secret doc. Returns null when never connected. */
export async function readStripeConnectionSecret(
  subAccountId: string,
): Promise<StripeConnectionSecret | null> {
  const snap = await getAdminDb().doc(stripeConnectionSecretPath(subAccountId)).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<StripeConnectionSecret> | undefined;
  if (!data) return null;

  // Legacy/absent `mode` reads as "key" — same defaulting pattern as
  // WebsiteConfig.build_type falling back to "local".
  const mode = data.mode ?? "key";
  if (mode === "connect") {
    const id = (data as { connectedAccountId?: string }).connectedAccountId;
    if (!id) return null;
    return { mode: "connect", connectedAccountId: id };
  }

  const key = (data as { restrictedKey?: string }).restrictedKey;
  if (!key) return null;
  return {
    mode: "key",
    restrictedKey: key,
    webhookSecret: (data as { webhookSecret?: string }).webhookSecret ?? "",
  };
}

/**
 * Build a Stripe client bound to one sub-account's own Stripe account.
 *
 * Throws `StripeConnectionError` rather than returning null so a caller can't
 * accidentally fall through to the agency's Stripe — charging the wrong
 * account is the worst possible failure mode here.
 */
export async function getSubAccountStripe(
  subAccountId: string,
): Promise<SubAccountStripe> {
  const conn = await readStripeConnectionSecret(subAccountId);
  if (!conn) {
    throw new StripeConnectionError(
      "not_connected",
      "This workspace hasn't connected a Stripe account yet.",
    );
  }

  if (conn.mode === "key") {
    if (!conn.webhookSecret) {
      // Payments would succeed with no way to hear about them — the order
      // would sit `pending` forever. Refuse rather than take money blind.
      throw new StripeConnectionError(
        "not_ready",
        "Stripe is connected but its webhook isn't set up yet, so payments couldn't be confirmed. Finish the webhook step in Settings → Payments.",
      );
    }
    return {
      // Key mode authenticates via the client itself, so there is NO options
      // bag — see the note on `opts`.
      stripe: new Stripe(conn.restrictedKey),
      opts: undefined,
      mode: "key",
      webhookSecret: conn.webhookSecret,
    };
  }

  // Tier 2 — the branch exists so the shape is settled, but nothing creates a
  // "connect" secret in v1.
  return {
    stripe: getStripeServer(),
    opts: { stripeAccount: conn.connectedAccountId },
    mode: "connect",
    webhookSecret: "",
  };
}

/**
 * Create a Checkout Session on the sub-account's own Stripe account.
 *
 * THE call site for the seam — use this instead of `getSubAccountStripe()`
 * plus a hand-written `create(params, opts)`. Two reasons:
 *
 *  1. It hides the options-bag trap. stripe-node throws
 *     "Unknown arguments ([object Object])" if you hand it an empty `{}` as
 *     the second argument, which is exactly what key mode produces. Passing
 *     the argument only in connect mode is the whole fix, and it should live
 *     in one place, not four routes.
 *  2. It keeps Tier 2 a one-line change here rather than a sweep.
 */
export async function createCheckoutSessionForSubAccount(input: {
  subAccountId: string;
  params: Stripe.Checkout.SessionCreateParams;
}): Promise<Stripe.Checkout.Session> {
  const ctx = await getSubAccountStripe(input.subAccountId);
  if (ctx.mode === "connect" && ctx.opts) {
    return ctx.stripe.checkout.sessions.create(input.params, ctx.opts);
  }
  return ctx.stripe.checkout.sessions.create(input.params);
}

/**
 * Probe a restricted key before storing it. Returns display metadata on
 * success; throws Stripe's own error (surfaced verbatim to the operator) when
 * the key is invalid or under-scoped.
 *
 * `accounts.retrieve()` needs Account read. That scope is harmless (read-only
 * business details) and is what lets the settings card say WHICH account is
 * connected — but a key without it should still be usable, so a failure here
 * degrades to `{ accountId: null }` rather than blocking the connection.
 */
export async function probeRestrictedKey(restrictedKey: string): Promise<{
  accountId: string | null;
  accountName: string | null;
}> {
  const stripe = new Stripe(restrictedKey);
  try {
    const account = await stripe.accounts.retrieve();
    return {
      accountId: account.id ?? null,
      accountName:
        account.business_profile?.name ??
        account.settings?.dashboard?.display_name ??
        null,
    };
  } catch (err) {
    // Permission errors here mean "no Account read scope", not "bad key" — the
    // caller validates the key separately via a scope we actually require.
    if (
      err instanceof Stripe.errors.StripeError &&
      err.type === "StripePermissionError"
    ) {
      return { accountId: null, accountName: null };
    }
    throw err;
  }
}
