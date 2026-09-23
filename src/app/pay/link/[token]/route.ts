import { NextResponse } from "next/server";

import { checkCheckoutRateLimit, clientIpFrom } from "@/lib/checkout/rate-limit";
import { formatCurrency } from "@/lib/format";
import {
  loadPayableLink,
  startPaymentLinkCheckout,
} from "@/lib/server/payment-links-service";

export const dynamic = "force-dynamic";

/**
 * Public Paystack payment link — `/pay/link/{token}`.
 *
 * GET  shows what is being paid and asks for the payer's email (Paystack will
 *      not open a checkout without one). Paystack also sends the payer back
 *      here after checkout, with `?reference=…`.
 * POST takes the email and 303s to Paystack's hosted checkout.
 *
 * NEITHER handler marks anything paid, whatever the query string says. A
 * returning payer sees "confirming"; the link flips to paid only when the
 * sub-account's verified webhook reaches `payment-link-reconciler.ts`.
 *
 * The token is the credential: HMAC-verified, then matched against the doc.
 * The amount comes from the doc — the POST reads only `email`.
 */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fafafa;color:#18181b;margin:0;">
<div style="max-width:420px;width:100%;padding:32px;box-sizing:border-box;text-align:center;">${body}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function deadLink(message: string, status: number): NextResponse {
  return page(
    "Payment link",
    `<h1 style="font-size:20px;margin:0 0 8px;">This payment link can't be used</h1>
<p style="color:#52525b;font-size:14px;line-height:1.6;">${esc(message)}</p>`,
    status,
  );
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const returning = new URL(request.url).searchParams.has("reference");
  const loaded = await loadPayableLink(token, { returning });
  if (!loaded.ok) return deadLink(loaded.error, loaded.status);
  const { link, mode } = loaded;
  const amount = formatCurrency(link.amountCents / 100, link.currency);

  if (returning) {
    return page(
      "Confirming payment",
      `<h1 style="font-size:20px;margin:0 0 8px;">Confirming your payment</h1>
<p style="color:#52525b;font-size:14px;line-height:1.6;">Paystack is confirming your payment of ${esc(amount)} for ${esc(link.description)}. You can close this page — the sender is notified once it's confirmed.</p>`,
    );
  }

  // The mode checkout will charge in: the link's own, which the checkout
  // re-checks against the key inside the transaction that records the attempt.
  const testBanner = mode === "live"
    ? ""
    : `<p style="background:#fef3c7;color:#92400e;font-size:13px;font-weight:600;padding:8px 12px;border-radius:8px;margin:0 0 16px;">TEST MODE — no real money will be taken</p>`;
  // A card-on-file link states its recurring terms above the button — the
  // exact wording the checkout then records as the payer's consent.
  const terms = link.mandate
    ? `<p style="background:#f4f4f5;color:#18181b;font-size:13px;line-height:1.6;text-align:left;padding:12px;border-radius:8px;margin:0 0 16px;">${esc(link.mandate.text)}</p>`
    : "";
  return page(
    link.description,
    `${testBanner}<p style="color:#52525b;font-size:14px;margin:0 0 4px;">${esc(link.description)}</p>
<h1 style="font-size:28px;margin:0 0 24px;">${esc(amount)}</h1>
${terms}<form method="post" style="display:flex;flex-direction:column;gap:12px;text-align:left;">
<label for="email" style="font-size:14px;">Your email (for the receipt)</label>
<input id="email" name="email" type="email" required autocomplete="email" style="padding:10px;font-size:16px;border:1px solid #d4d4d8;border-radius:8px;">
<button type="submit" style="padding:12px;font-size:16px;border:0;border-radius:8px;background:#18181b;color:#fff;cursor:pointer;">Pay ${esc(amount)}${link.mandate ? " and save card" : ""}</button>
</form>
<p style="color:#71717a;font-size:12px;margin-top:16px;">Secure payment by Paystack.</p>`,
  );
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const ip = clientIpFrom(request);
  const rate = checkCheckoutRateLimit(ip);
  if (!rate.ok) {
    return new NextResponse("Too many attempts. Please try again shortly.", {
      status: 429,
      headers: { "Retry-After": String(rate.retryAfterSec) },
    });
  }

  let email = "";
  try {
    email = String((await request.formData()).get("email") ?? "").trim();
  } catch {
    // Not a form post — falls through to the invalid-email answer below.
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return deadLink("Enter a valid email address and try again.", 400);
  }

  const started = await startPaymentLinkCheckout({ token, email, ip });
  if (!started.ok) return deadLink(started.error, started.status);
  return NextResponse.redirect(started.url, 303);
}
