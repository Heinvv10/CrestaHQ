import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcilePaystackCharge } from "@/lib/paystack/payment-link-reconciler";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { verifyPaystackSignature } from "@/lib/paystack/webhook-signature";

export const dynamic = "force-dynamic";

/**
 * Per-sub-account Paystack webhook.
 *
 * NOT `/api/webhooks/paystack` — that endpoint belongs to the AGENCY's own
 * Paystack account (Client Billing) and verifies against the deployment's
 * `PAYSTACK_SECRET_KEY`. This one verifies against the key of ONE sub-account,
 * stored at `subAccounts/{id}/private/paystackConnection`.
 *
 * Public path (the `/api/webhooks/paystack` prefix in middleware's PUBLIC_PATHS
 * already covers it; the explicit pattern is there so the route is findable).
 * **The signature IS the credential** — Paystack signs the raw body with
 * HMAC-SHA512 keyed on the account's secret key, so there is no separate
 * webhook secret. The sub-account id in the URL is untrusted routing
 * information: it only selects which stored key to verify against, and a
 * request that cannot produce a valid signature for that key gets nothing.
 *
 * WHAT IT DOES WITH THE EVENT: records that a verified webhook arrived — the
 * ONLY honest evidence that the operator completed the dashboard registration
 * step, and what the settings card reads (`paystackConnectionMeta.webhookSeenAt`).
 * Then `charge.success` goes to the payment-link reconciler, which re-verifies
 * the transaction with Paystack before marking anything paid.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  const { subAccountId } = await ctx.params;

  // The RAW body is what was signed — parsing first and re-serializing would
  // change the bytes and fail every signature.
  const rawBody = await request.text();

  const conn = await readPaystackConnectionSecret(subAccountId);
  if (!conn) {
    // Disconnected but Paystack is still delivering. Nothing can be verified
    // without the key, so nothing may be acted on — and 200 rather than an
    // error so the operator's endpoint is not disabled by retries while they
    // are mid-reconnect.
    console.warn(
      `[webhooks/paystack/sa] no connection sa=${subAccountId} — dropping event`,
    );
    return NextResponse.json({ received: true, ignored: "not_connected" });
  }

  if (
    !verifyPaystackSignature(
      rawBody,
      request.headers.get("x-paystack-signature"),
      conn.secretKey,
    )
  ) {
    // The ONE case that must be non-200: an unverified body is not Paystack.
    console.error(
      `[webhooks/paystack/sa] signature verification failed sa=${subAccountId}`,
    );
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  // `update`, not `set(..., { merge: true })`. Only `update` reads a dotted key
  // as a path into the nested map; `set` would create a field literally named
  // "paystackConnectionMeta.webhookSeenAt" beside the real object, leaving the
  // card reading undefined forever.
  //
  // Written on every verified event rather than only the first: a conditional
  // write would cost a read of the parent doc per event to save one field
  // update, and the freshest timestamp is the more useful thing to show anyway.
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .update({ "paystackConnectionMeta.webhookSeenAt": new Date() });

  const reference = chargeSuccessReference(rawBody);
  if (reference) {
    const result = await reconcilePaystackCharge({
      subAccountId,
      secretKey: conn.secretKey,
      reference,
    });
    // Only "couldn't ask Paystack" is worth a redelivery. A mismatch or a
    // foreign reference answers 200 so Paystack does not retry it forever.
    if (result.retry) {
      return NextResponse.json({ error: "retry" }, { status: 503 });
    }
  }

  return NextResponse.json({ received: true });
}

/** The reference of a `charge.success` body, else null. */
function chargeSuccessReference(rawBody: string): string | null {
  try {
    const event = JSON.parse(rawBody) as {
      event?: unknown;
      data?: { reference?: unknown };
    };
    return event.event === "charge.success" &&
      typeof event.data?.reference === "string"
      ? event.data.reference
      : null;
  } catch {
    console.warn("[webhooks/paystack/sa] signed body is not JSON — ignoring");
    return null;
  }
}
