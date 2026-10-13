import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  noPlatformSender,
  resolvePlatformSender,
  sendPlatformEmail,
} from "@/lib/comms/platform-email";
import { renderSystemEmail } from "@/lib/comms/system-email";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { formatBillingPrice } from "@/lib/billing/status";
import { usageCurrency } from "@/lib/billing/currency";
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
    // The currency a new charge defaults to: the one its usage overage is
    // valued in, so invoicing the overage bills what the dialog showed.
    const sub = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    return NextResponse.json({ charges, currency: usageCurrency(sub.data()?.billing) });
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
    // Omitted: the currency the client's usage overage is valued in.
    const requested =
      body.currency ?? usageCurrency((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data()?.billing);
    const { description, amountCents, currency } = validateChargeInput(
      body.description,
      body.amountCents,
      requested,
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
  try {
    const sender = await resolvePlatformSender(opts.subAccountId);
    if (!sender) {
      noPlatformSender("[billing/charges] charge-link", opts.subAccountId);
      return false;
    }
    const snap = await getAdminDb().doc(`subAccounts/${opts.subAccountId}`).get();
    const workspaceName = String(snap.data()?.name ?? "your workspace");
    const subject = `Payment request: ${opts.description}`;
    const { text, html } = renderSystemEmail({
      brand: await resolveCustomBrand(),
      heading: "Payment request",
      paragraphs: [
        ["A one-time payment is requested for ", { bold: workspaceName }, ":"],
        [{ bold: opts.description }, ` — ${opts.priceLabel}`],
      ],
      button: { label: "Pay now", url: opts.url },
      note: "Payment is handled securely by Stripe. This is a one-time charge — no subscription is created.",
    });
    await sendPlatformEmail(sender, { to: opts.to, subject, text, html });
    return true;
  } catch (err) {
    // The link was still created/returned — email is best-effort.
    console.warn("[billing/charges] charge-link email failed", err);
    return false;
  }
}
