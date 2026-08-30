import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail } from "@/lib/comms/resend";
import { formatBillingPriceWithInterval } from "@/lib/billing/status";
import type { BillingInterval } from "@/types/billing";
import {
  assignPlanToSubAccount,
  BillingError,
  compSubAccount,
  mintCheckoutLink,
} from "@/lib/server/billing-service";

/**
 * Agency-owner billing controls for one sub-account (Client Billing v1) —
 * the Manage-dialog Billing tab posts here.
 *
 *   PATCH { action: "assign", planId, specialPriceCents?, emailTo? }
 *     Assign/switch the plan. Pending clients get a fresh checkout link
 *     back (and optionally emailed); live subscriptions are moved to the
 *     new price + gates immediately.
 *   PATCH { action: "comp" }
 *     Stop billing through the platform (cancels any live subscription).
 *   PATCH { action: "sendLink", emailTo? }
 *     Rotate + return the checkout link, optionally emailing it.
 *
 * Auth: agency owner only — same bar as the feature-gates route.
 */

interface PatchBody {
  action?: "assign" | "comp" | "sendLink";
  planId?: string;
  specialPriceCents?: number | null;
  /** Billing cadence for assign — "month" (default) or "year". */
  interval?: "month" | "year";
  /** When set, the checkout link is also emailed to this address. */
  emailTo?: string;
}

async function emailCheckoutLink(opts: {
  to: string;
  subAccountName: string;
  planName: string | null;
  /** Already includes the cadence suffix, e.g. "$990.00 AUD/yr". */
  priceLabel: string;
  /** "monthly" | "annually" — used in the reassurance copy. */
  cadenceWord: string;
  url: string;
}): Promise<void> {
  const subject = opts.planName
    ? `Activate your ${opts.planName} subscription`
    : "Activate your workspace subscription";
  const text = [
    `Your workspace "${opts.subAccountName}" is ready to activate.`,
    "",
    opts.planName ? `Plan: ${opts.planName} — ${opts.priceLabel}` : "",
    "",
    `Complete your subscription here: ${opts.url}`,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;">Activate your subscription</h2>
      <p>Your workspace <strong>${opts.subAccountName}</strong> is ready to activate${
        opts.planName
          ? ` on the <strong>${opts.planName}</strong> plan (${opts.priceLabel})`
          : ""
      }.</p>
      <p style="margin:24px 0;">
        <a href="${opts.url}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Complete checkout</a>
      </p>
      <p style="color:#6b7280;font-size:13px;">Payment is handled securely by Stripe. Your card is charged ${opts.cadenceWord} and you can update it anytime from your workspace settings.</p>
    </div>`;
  await sendEmail({ to: opts.to, subject, text, html });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const emailTo =
    typeof body.emailTo === "string" && body.emailTo.includes("@")
      ? body.emailTo.trim()
      : null;

  try {
    if (body.action === "comp") {
      await compSubAccount({ agencyId: access.agencyId!, subAccountId });
      return NextResponse.json({ ok: true, status: "comped" });
    }

    if (body.action === "assign") {
      if (typeof body.planId !== "string" || !body.planId) {
        return NextResponse.json(
          { error: "planId is required for assign." },
          { status: 400 },
        );
      }
      const specialPriceCents =
        typeof body.specialPriceCents === "number"
          ? body.specialPriceCents
          : null;
      const interval = body.interval === "year" ? "year" : "month";
      const result = await assignPlanToSubAccount({
        agencyId: access.agencyId!,
        subAccountId,
        planId: body.planId,
        specialPriceCents,
        interval,
      });

      let emailed = false;
      if (result.checkoutUrl && emailTo) {
        emailed = await maybeEmailLink(subAccountId, emailTo, result.checkoutUrl);
      }
      return NextResponse.json({
        ok: true,
        status: result.status,
        checkoutUrl: result.checkoutUrl,
        emailed,
      });
    }

    if (body.action === "sendLink") {
      const url = await mintCheckoutLink({
        agencyId: access.agencyId!,
        subAccountId,
      });
      if (!url) {
        return NextResponse.json(
          { error: "NEXT_PUBLIC_APP_URL isn't configured — can't build the link." },
          { status: 500 },
        );
      }
      let emailed = false;
      if (emailTo) {
        emailed = await maybeEmailLink(subAccountId, emailTo, url);
      }
      return NextResponse.json({ ok: true, checkoutUrl: url, emailed });
    }

    return NextResponse.json(
      { error: 'action must be "assign", "comp", or "sendLink".' },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[api/agency/sub-accounts/billing] failed", err);
    return NextResponse.json(
      { error: "Billing update failed." },
      { status: 500 },
    );
  }
}

async function maybeEmailLink(
  subAccountId: string,
  to: string,
  url: string,
): Promise<boolean> {
  if (!emailIsConfigured()) return false;
  try {
    const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    const data = snap.data() ?? {};
    const billing = (data.billing ?? {}) as {
      planName?: string | null;
      priceCents?: number | null;
      currency?: string | null;
      billingInterval?: BillingInterval | null;
    };
    await emailCheckoutLink({
      to,
      subAccountName: String(data.name ?? "your workspace"),
      planName: billing.planName ?? null,
      priceLabel: formatBillingPriceWithInterval(
        billing.priceCents,
        billing.currency,
        billing.billingInterval,
      ),
      cadenceWord: billing.billingInterval === "year" ? "annually" : "monthly",
      url,
    });
    return true;
  } catch (err) {
    // The link was still minted/returned — email is best-effort.
    console.warn("[billing] checkout-link email failed", err);
    return false;
  }
}
