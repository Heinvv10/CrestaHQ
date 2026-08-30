import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { verifyCheckoutToken } from "@/lib/billing/token";
import {
  BillingError,
  createSubAccountCheckoutSession,
} from "@/lib/server/billing-service";

export const dynamic = "force-dynamic";

/**
 * Public checkout entry (Client Billing v1). The tokenized link the agency
 * emails/copies to a client resolves here; a valid token 303s straight into
 * Stripe Checkout for that sub-account's assigned plan.
 *
 * Security: HMAC token verification + hash match against the CURRENT
 * `billing.checkoutTokenHash` (re-sending rotates the hash, killing old
 * links) — same model as public quote links. Mail scanners GETting the URL
 * just create checkout sessions that expire unused; nothing is charged
 * without completing Stripe's payment page.
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

  const verified = verifyCheckoutToken(token);
  if (!verified) {
    return deadLink(
      "The link may be incomplete or expired. Ask your provider to send a fresh payment link.",
    );
  }

  const snap = await getAdminDb()
    .doc(`subAccounts/${verified.subAccountId}`)
    .get();
  const billing = snap.data()?.billing as
    | { checkoutTokenHash?: string | null; status?: string }
    | undefined;
  if (!snap.exists || billing?.checkoutTokenHash !== verified.hash) {
    // Rotated (a newer link was sent) or consumed (already activated).
    if (billing?.status === "active") {
      return deadLink(
        "This subscription is already active — nothing more to pay. You can log in to your workspace as usual.",
      );
    }
    return deadLink(
      "A newer payment link has been issued. Use the most recent email from your provider, or ask them to re-send it.",
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const statusUrl = `${base}/pay/${token}/status`;

  try {
    const { url } = await createSubAccountCheckoutSession({
      subAccountId: verified.subAccountId,
      successUrl: `${statusUrl}?done=1`,
      cancelUrl: `${statusUrl}?cancelled=1`,
    });
    return NextResponse.redirect(url, 303);
  } catch (err) {
    if (err instanceof BillingError) {
      return deadLink(err.message);
    }
    console.error("[pay] checkout session create failed", err);
    return deadLink(
      "Something went wrong starting checkout. Please try again in a minute or contact your provider.",
    );
  }
}
