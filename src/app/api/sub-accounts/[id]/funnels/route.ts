import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  FunnelError,
  assertFunnelSlugAvailable,
  sanitizeFunnelPayload,
  type FunnelPayload,
} from "@/lib/funnels/sanitize";
import { funnelTemplate } from "@/lib/funnels/templates";
import { emptySection, templateSections } from "@/lib/funnels/sections";
import { ensureCheckoutPageForProduct } from "@/lib/checkout/create-from-product";
import { CheckoutPageError } from "@/lib/checkout/sanitize";
import { defaultFunnelStyle, slugifyFunnelSlug } from "@/types/funnels";
import { defaultFormAppearance } from "@/types/forms";

/**
 * Create a funnel (Labs experiment). Admin-only, gated on
 * `labsEnabledByAgency` — the same gate that shows the Labs surface at all.
 *
 * Reads are client-side via onSnapshot (rules allow member read); only writes
 * come through here so slug uniqueness and the video host allow-list can't be
 * bypassed from a browser.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: FunnelPayload;
  try {
    body = (await request.json()) as FunnelPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (subSnap.data()?.labsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Labs isn't enabled for this workspace." },
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

  try {
    const patch = sanitizeFunnelPayload(body);
    const template = funnelTemplate(patch.template ?? "simple_offer");
    const name = patch.name || template.label;
    const slug = patch.slug || slugifyFunnelSlug(name);

    await assertFunnelSlugAvailable({ subAccountId, slug });

    const ref = db.collection(`subAccounts/${subAccountId}/funnels`).doc();

    // Picking a product creates a REAL checkout page (visible + editable in
    // the Checkout list) rather than letting the funnel own a price. One
    // money path, no hidden entities.
    let checkoutPageId = patch.checkoutPageId ?? null;
    if (patch.productId) {
      checkoutPageId = await ensureCheckoutPageForProduct({
        agencyId,
        subAccountId,
        createdByUid: access.uid,
        productId: patch.productId,
        ownerKey: `funnel:${ref.id}`,
        label: name,
      });
    }

    // Seed the page from the template so a new funnel isn't a blank canvas.
    const seeded =
      patch.sections && patch.sections.length > 0
        ? patch.sections
        : templateSections(template.key).map((t, i) =>
            emptySection(t, `s${i}`),
          );

    await ref.set({
      agencyId,
      subAccountId,
      createdByUid: access.uid,
      slug,
      name,
      // Drafts always — publishing runs its own checks (see the PATCH route).
      status: "draft",
      template: template.key,
      landing: patch.landing ?? template.landing,
      sections: seeded,
      productId: patch.productId ?? null,
      checkoutPageId,
      ctaUrl: patch.ctaUrl ?? null,
      thanks: patch.thanks ?? template.thanks,
      // Ember orange, NOT the app-wide purple default: purple-accent pages
      // are the single most recognisable "AI-generated" tell, and orange is a
      // proven CTA colour. Operators change it per funnel in appearance.
      appearance: patch.appearance ?? {
        ...defaultFormAppearance(),
        accent: "#e8542f",
      },
      style: patch.style ?? defaultFunnelStyle(),
      stickyCta: patch.stickyCta ?? true,
      ctaSubtitle: patch.ctaSubtitle ?? "",
      topBanner: patch.topBanner ?? "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ id: ref.id, slug }, { status: 201 });
  } catch (err) {
    if (err instanceof FunnelError || err instanceof CheckoutPageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[funnels/create] failed", err);
    return NextResponse.json(
      { error: "Failed to create the funnel." },
      { status: 500 },
    );
  }
}
