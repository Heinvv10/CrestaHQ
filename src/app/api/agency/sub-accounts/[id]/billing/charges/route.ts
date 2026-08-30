import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail } from "@/lib/comms/resend";
import { formatBillingPrice } from "@/lib/billing/status";
import {
  BillingError,
  createOneTimeCharge,
  listChargesForSubAccount,
  validateChargeInput,
} from "@/lib/server/billing-service";

/**
 * One-time charges for a sub-account (agency → client, e.g. "Web design").
 *
 *   GET  — list this sub-account's charges (newest first).
 *   POST { description, amountCents, currency?, emailTo? }
 *        — create a charge + return its /pay/charge link (optionally emailed).
 *
 * Auth: agency owner only — same bar as the plan-billing route.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  try {
    const charges = await listChargesForSubAccount(
      access.agencyId!,
      subAccountId,
    );
    return NextResponse.json({ charges });
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[billing/charges] list failed", err);
    return NextResponse.json(
      { error: "Failed to load charges." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (access.subAccountRole !== "agencyOwner") {
    return NextResponse.json({ error: "Agency owner only" }, { status: 403 });
  }

  let body: {
    description?: string;
    amountCents?: number;
    currency?: string;
    emailTo?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { description, amountCents, currency } = validateChargeInput(
      body.description,
      body.amountCents,
      body.currency ?? "usd",
    );
    const { charge, checkoutUrl } = await createOneTimeCharge({
      agencyId: access.agencyId!,
      subAccountId,
      createdByUid: access.uid,
      description,
      amountCents,
      currency,
    });
    if (!checkoutUrl) {
      return NextResponse.json(
        { error: "NEXT_PUBLIC_APP_URL isn't configured — can't build the link." },
        { status: 500 },
      );
    }

    const emailTo =
      typeof body.emailTo === "string" && body.emailTo.includes("@")
        ? body.emailTo.trim()
        : null;
    let emailed = false;
    if (emailTo) {
      emailed = await maybeEmailChargeLink({
        subAccountId,
        to: emailTo,
        description,
        priceLabel: formatBillingPrice(amountCents, currency),
        url: checkoutUrl,
      });
    }

    return NextResponse.json(
      { ok: true, charge, checkoutUrl, emailed },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof BillingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[billing/charges] create failed", err);
    return NextResponse.json(
      { error: "Failed to create the charge." },
      { status: 500 },
    );
  }
}

async function maybeEmailChargeLink(opts: {
  subAccountId: string;
  to: string;
  description: string;
  priceLabel: string;
  url: string;
}): Promise<boolean> {
  if (!emailIsConfigured()) return false;
  try {
    const snap = await getAdminDb().doc(`subAccounts/${opts.subAccountId}`).get();
    const workspaceName = String(snap.data()?.name ?? "your workspace");
    const subject = `Payment request: ${opts.description}`;
    const text = [
      `A payment is requested for "${workspaceName}".`,
      "",
      `${opts.description} — ${opts.priceLabel} (one-time)`,
      "",
      `Pay securely here: ${opts.url}`,
    ].join("\n");
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 12px;">Payment request</h2>
        <p>A one-time payment is requested for <strong>${workspaceName}</strong>:</p>
        <p style="font-size:16px;"><strong>${opts.description}</strong> — ${opts.priceLabel}</p>
        <p style="margin:24px 0;">
          <a href="${opts.url}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Pay now</a>
        </p>
        <p style="color:#6b7280;font-size:13px;">Payment is handled securely by Stripe. This is a one-time charge — no subscription is created.</p>
      </div>`;
    await sendEmail({ to: opts.to, subject, text, html });
    return true;
  } catch (err) {
    // The link was still created/returned — email is best-effort.
    console.warn("[billing/charges] charge-link email failed", err);
    return false;
  }
}
