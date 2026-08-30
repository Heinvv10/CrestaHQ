import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { readStripeConnectionSecret } from "@/lib/stripe/sub-account-client";
import {
  CheckoutPageError,
  assertSlugAvailable,
  sanitizeCheckoutPagePayload,
  validateCheckoutProducts,
  type CheckoutPagePayload,
} from "@/lib/checkout/sanitize";
import type { CheckoutPage } from "@/types/checkout-pages";

/**
 * Update / delete one checkout page (Payments v1). Admin-only, gated.
 *
 * PATCH  — partial update. Re-validates products + slug on every write, so a
 *          page can't drift into an unpayable state (archived bump, currency
 *          mismatch) after it was first saved.
 * DELETE — removes the page. Orders that referenced it keep their
 *          `checkoutPageId` as a dangling id; they snapshot their own line
 *          items, so nothing about a historical order depends on the page.
 */

async function loadGated(subAccountId: string, pageId: string) {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    throw new CheckoutPageError("Sub-account not found", 404);
  }
  if (subSnap.data()?.paymentsEnabledByAgency !== true) {
    throw new CheckoutPageError(
      "Payments isn't enabled for this workspace. Ask your agency to turn it on.",
      403,
    );
  }
  const ref = db.doc(`subAccounts/${subAccountId}/checkoutPages/${pageId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new CheckoutPageError("Checkout page not found", 404);
  return { ref, page: { id: snap.id, ...(snap.data() as Omit<CheckoutPage, "id">) } };
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; pageId: string }> },
) {
  const { id: subAccountId, pageId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CheckoutPagePayload;
  try {
    body = (await request.json()) as CheckoutPagePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { ref, page } = await loadGated(subAccountId, pageId);
    const patch = sanitizeCheckoutPagePayload(body);

    const nextSlug = patch.slug ?? page.slug;
    if (nextSlug !== page.slug) {
      await assertSlugAvailable({
        subAccountId,
        slug: nextSlug,
        exceptPageId: pageId,
      });
    }

    await validateCheckoutProducts({
      subAccountId,
      productId: patch.productId ?? page.productId,
      bumpProductIds: patch.bumpProductIds ?? page.bumpProductIds,
    });

    // Publishing is the point of no return — a published page is publicly
    // payable, so refuse it while Stripe can't actually confirm payments.
    // Without this, a buyer could pay and the order would sit `pending`
    // forever with no webhook to resolve it.
    const nextStatus = patch.status ?? page.status;
    if (nextStatus === "published" && page.status !== "published") {
      const conn = await readStripeConnectionSecret(subAccountId);
      if (!conn) {
        throw new CheckoutPageError(
          "Connect Stripe in Settings → Payments before publishing a checkout page.",
        );
      }
      if (conn.mode === "key" && !conn.webhookSecret) {
        throw new CheckoutPageError(
          "Stripe is connected but its webhook isn't finished, so payments couldn't be confirmed. Complete the webhook step in Settings → Payments first.",
        );
      }
    }

    await ref.set(
      { ...patch, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return NextResponse.json({ ok: true, slug: nextSlug, status: nextStatus });
  } catch (err) {
    if (err instanceof CheckoutPageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[checkout-pages/patch] failed", err);
    return NextResponse.json(
      { error: "Failed to save the checkout page." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; pageId: string }> },
) {
  const { id: subAccountId, pageId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    const { ref } = await loadGated(subAccountId, pageId);
    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CheckoutPageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[checkout-pages/delete] failed", err);
    return NextResponse.json(
      { error: "Failed to delete the checkout page." },
      { status: 500 },
    );
  }
}
