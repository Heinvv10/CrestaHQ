import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  CheckoutPageError,
  assertSlugAvailable,
  sanitizeCheckoutPagePayload,
  validateCheckoutProducts,
  type CheckoutPagePayload,
} from "@/lib/checkout/sanitize";
import { slugifyCheckoutSlug } from "@/types/checkout-pages";
import { defaultFormAppearance } from "@/types/forms";

/**
 * Checkout pages for one sub-account (Payments v1).
 *
 * POST — create. Admin-only, gated on `paymentsEnabledByAgency`.
 *
 * Reads are client-side via onSnapshot (rules allow member read), matching
 * bookingPages / products; only writes come through here so validation can't
 * be bypassed by a browser.
 */

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: CheckoutPagePayload;
  try {
    body = (await request.json()) as CheckoutPagePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (subSnap.data()?.paymentsEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "Payments isn't enabled for this workspace. Ask your agency to turn it on.",
      },
      { status: 403 },
    );
  }
  const agencyId =
    access.agencyId ?? (subSnap.data()?.agencyId as string | undefined);
  if (!agencyId) {
    return NextResponse.json(
      { error: "Sub-account is missing an agencyId" },
      { status: 500 },
    );
  }

  const patch = sanitizeCheckoutPagePayload(body);
  const name = patch.name || "Untitled checkout";
  const slug = patch.slug || slugifyCheckoutSlug(name);
  const productId = patch.productId ?? "";
  if (!productId) {
    return NextResponse.json(
      { error: "Pick the product this page sells." },
      { status: 400 },
    );
  }

  try {
    await assertSlugAvailable({ subAccountId, slug });
    await validateCheckoutProducts({
      subAccountId,
      productId,
      bumpProductIds: patch.bumpProductIds ?? [],
    });
  } catch (err) {
    if (err instanceof CheckoutPageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const ref = db.collection(`subAccounts/${subAccountId}/checkoutPages`).doc();
  await ref.set({
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    slug,
    name,
    // New pages start as drafts — publishing is a deliberate act, same as
    // booking pages. A half-configured page must not be publicly payable.
    status: "draft",
    productId,
    bumpProductIds: patch.bumpProductIds ?? [],
    headline: patch.headline ?? name,
    subheadline: patch.subheadline ?? "",
    collectFields: patch.collectFields ?? [],
    autoTags: patch.autoTags ?? [],
    pipelineStageId: patch.pipelineStageId ?? null,
    successUrl: patch.successUrl ?? null,
    appearance: patch.appearance ?? defaultFormAppearance(),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ id: ref.id, slug }, { status: 201 });
}
