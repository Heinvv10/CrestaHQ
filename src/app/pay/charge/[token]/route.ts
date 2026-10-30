import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyChargeToken } from "@/lib/billing/token";
import {
  BillingError,
  createChargeCheckoutSession,
} from "@/lib/server/billing-service";

export const dynamic = "force-dynamic";

/**
 * Public one-time-charge checkout entry. The tokenized link the agency
 * emails/copies to a client resolves here; a valid token 303s straight into
 * Stripe Checkout (mode:"payment") for that charge.
 *
 * Security mirrors /pay/[token]: HMAC verification (charge-domain-separated)
 * + hash match against the charge doc's CURRENT `tokenHash` (re-sending
 * rotates it; paying or canceling clears it, so consumed links die).
 */

function deadLink(message: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Payment link</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fafafa;color:#18181b;">
<div style="max-width:420px;padding:32px;text-align:center;">
<h1 style="font-size:20px;margin:0 0 8px;">This payment link isn't valid</h1>
<p style="color:#52525b;font-size:14px;line-height:1.6;">${message}</p>
</div></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const verified = verifyChargeToken(token);
  if (!verified) {
    return deadLink(
      "The link may be incomplete or expired. Ask your provider to send a fresh payment link.",
    );
  }

  const snap = await getAdminDb()
    .doc(`billingCharges/${verified.chargeId}`)
    .get();
  const charge = snap.data() as
    | { tokenHash?: string | null; status?: string }
    | undefined;
  if (!snap.exists || charge?.tokenHash !== verified.hash) {
    if (charge?.status === "paid") {
      return deadLink("This payment has already been made — nothing more to pay.");
    }
    if (charge?.status === "canceled") {
      return deadLink(
        "This payment request was withdrawn. Contact your provider if you believe that's a mistake.",
      );
    }
    return deadLink(
      "A newer payment link has been issued. Use the most recent email from your provider, or ask them to re-send it.",
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const statusUrl = `${base}/pay/charge/${token}/status`;

  try {
    const { url } = await createChargeCheckoutSession({
      chargeId: verified.chargeId,
      successUrl: `${statusUrl}?done=1`,
      cancelUrl: `${statusUrl}?cancelled=1`,
    });
    return NextResponse.redirect(url, 303);
  } catch (err) {
    if (err instanceof BillingError) {
      return deadLink(err.message);
    }
    console.error("[pay/charge] checkout session create failed", err);
    return deadLink(
      "Something went wrong starting checkout. Please try again in a minute or contact your provider.",
    );
  }
}
