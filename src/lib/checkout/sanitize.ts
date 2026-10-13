import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  MAX_BUMPS_PER_CHECKOUT_PAGE,
  checkoutSlugError,
  slugifyCheckoutSlug,
  type CheckoutPage,
} from "@/types/checkout-pages";
import { isCheckoutThemeId } from "@/lib/checkout/themes";
import { defaultFormAppearance, type FormField } from "@/types/forms";
import type { Product } from "@/types/products";

/**
 * Shared checkout-page payload sanitizer + validator.
 *
 * Lives in lib/ (not a route.ts) because Next 15 forbids non-handler exports
 * from route files, and both the collection route and the `[pageId]` route
 * need it — same reason `lib/products/sanitize.ts` exists.
 */

export class CheckoutPageError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CheckoutPageError";
    this.status = status;
  }
}

export interface CheckoutPagePayload {
  name?: string;
  slug?: string;
  status?: "draft" | "published";
  productId?: string;
  bumpProductIds?: string[];
  headline?: string;
  subheadline?: string;
  collectFields?: FormField[];
  autoTags?: string[];
  pipelineStageId?: string | null;
  successUrl?: string | null;
  themePreset?: string | null;
  appearance?: Partial<CheckoutPage["appearance"]>;
}

function sanitizeFields(raw: unknown): FormField[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, 12).map((f, i) => {
    const field = (f ?? {}) as Partial<FormField>;
    return {
      id: typeof field.id === "string" && field.id ? field.id : `f${i}`,
      type: field.type ?? "text",
      label: (field.label ?? "").toString().trim().slice(0, 120),
      placeholder: (field.placeholder ?? "").toString().trim().slice(0, 120),
      required: field.required === true,
      options: Array.isArray(field.options)
        ? field.options.slice(0, 30).map((o) => String(o).slice(0, 120))
        : [],
      mapsTo: field.mapsTo ?? null,
      ...(field.consentText
        ? { consentText: String(field.consentText).slice(0, 1_000) }
        : {}),
    } as FormField;
  });
}

export function sanitizeCheckoutPagePayload(
  body: CheckoutPagePayload,
): Partial<CheckoutPage> {
  const out: Partial<CheckoutPage> = {};

  if (typeof body.name === "string") out.name = body.name.trim().slice(0, 120);
  if (typeof body.slug === "string") out.slug = slugifyCheckoutSlug(body.slug);
  if (body.status === "draft" || body.status === "published") {
    out.status = body.status;
  }
  if (typeof body.productId === "string") out.productId = body.productId.trim();
  if (Array.isArray(body.bumpProductIds)) {
    // Dedupe + cap. A bump listed twice would double-charge on tick.
    out.bumpProductIds = [
      ...new Set(body.bumpProductIds.filter((s) => typeof s === "string" && s)),
    ].slice(0, MAX_BUMPS_PER_CHECKOUT_PAGE);
  }
  if (typeof body.headline === "string") {
    out.headline = body.headline.trim().slice(0, 160);
  }
  if (typeof body.subheadline === "string") {
    out.subheadline = body.subheadline.trim().slice(0, 300);
  }
  const fields = sanitizeFields(body.collectFields);
  if (fields) out.collectFields = fields;
  if (Array.isArray(body.autoTags)) {
    out.autoTags = [
      ...new Set(
        body.autoTags
          .filter((t) => typeof t === "string")
          .map((t) => t.trim().slice(0, 60))
          .filter(Boolean),
      ),
    ].slice(0, 20);
  }
  if (body.pipelineStageId !== undefined) {
    out.pipelineStageId = (body.pipelineStageId || null) as
      | CheckoutPage["pipelineStageId"];
  }
  if (body.successUrl !== undefined) {
    const raw = (body.successUrl ?? "").toString().trim();
    if (!raw) {
      out.successUrl = null;
    } else if (!/^https:\/\//i.test(raw)) {
      // http:// would downgrade a post-payment redirect — refuse rather than
      // silently upgrade, so the operator fixes the real link.
      throw new CheckoutPageError("Success URL must start with https://");
    } else {
      out.successUrl = raw.slice(0, 500);
    }
  }
  if (body.themePreset !== undefined) {
    if (body.themePreset === null || body.themePreset === "") {
      out.themePreset = null;
    } else if (isCheckoutThemeId(body.themePreset)) {
      out.themePreset = body.themePreset;
    } else {
      throw new CheckoutPageError("Unknown style preset.");
    }
  }
  if (body.appearance) {
    const d = defaultFormAppearance();
    out.appearance = {
      theme: body.appearance.theme === "dark" ? "dark" : "light",
      accent:
        typeof body.appearance.accent === "string" &&
        /^#[0-9a-f]{6}$/i.test(body.appearance.accent)
          ? body.appearance.accent.toLowerCase()
          : d.accent,
      hideChrome: body.appearance.hideChrome === true,
      hideTitle: body.appearance.hideTitle === true,
    };
  }

  return out;
}

/**
 * Validate the product references against the live catalog.
 *
 * The currency check is the important one: Stripe Checkout can't mix
 * currencies in a single session, so a bump priced in EUR on a USD offer would
 * fail at the worst possible moment — after the buyer clicks pay. Catch it at
 * save time instead.
 */
export async function validateCheckoutProducts(input: {
  subAccountId: string;
  productId: string;
  bumpProductIds: string[];
}): Promise<{ currency: string }> {
  const db = getAdminDb();

  const mainSnap = await db.doc(`products/${input.productId}`).get();
  if (!mainSnap.exists) {
    throw new CheckoutPageError("That product no longer exists.");
  }
  const main = mainSnap.data() as Product;
  if (main.subAccountId !== input.subAccountId) {
    // Cross-tenant reference — refuse and don't reveal it exists elsewhere.
    throw new CheckoutPageError("That product no longer exists.");
  }
  if (!main.active) {
    throw new CheckoutPageError(
      "That product is archived. Restore it, or pick another.",
    );
  }
  if (main.unitPriceCents <= 0) {
    throw new CheckoutPageError(
      "The main product needs a price above zero — a checkout page can't collect nothing.",
    );
  }

  const currency = (main.currency || "USD").toUpperCase();

  for (const bumpId of input.bumpProductIds) {
    if (bumpId === input.productId) {
      throw new CheckoutPageError(
        "The main product can't also be an order bump.",
      );
    }
    const snap = await db.doc(`products/${bumpId}`).get();
    if (!snap.exists) throw new CheckoutPageError("An order bump no longer exists.");
    const bump = snap.data() as Product;
    if (bump.subAccountId !== input.subAccountId) {
      throw new CheckoutPageError("An order bump no longer exists.");
    }
    if (!bump.active) {
      throw new CheckoutPageError(
        `Order bump "${bump.name}" is archived. Restore it, or remove it from this page.`,
      );
    }
    if (bump.bumpEligible !== true) {
      throw new CheckoutPageError(
        `"${bump.name}" isn't marked as an order bump. Tick "Offer as an order bump" on the product first.`,
      );
    }
    if ((bump.currency || "USD").toUpperCase() !== currency) {
      throw new CheckoutPageError(
        `"${bump.name}" is priced in ${bump.currency} but the main product is in ${currency}. Stripe can't mix currencies in one checkout.`,
      );
    }
    if (bump.unitPriceCents <= 0) {
      throw new CheckoutPageError(
        `Order bump "${bump.name}" needs a price above zero.`,
      );
    }
  }

  return { currency };
}

/** Slug must be unique per sub-account — it's the public URL. */
export async function assertSlugAvailable(input: {
  subAccountId: string;
  slug: string;
  /** Existing page being edited, so it doesn't collide with itself. */
  exceptPageId?: string;
}): Promise<void> {
  const err = checkoutSlugError(input.slug);
  if (err) throw new CheckoutPageError(err);

  const snap = await getAdminDb()
    .collection(`subAccounts/${input.subAccountId}/checkoutPages`)
    .where("slug", "==", input.slug)
    .limit(2)
    .get();

  const clash = snap.docs.find((d) => d.id !== input.exceptPageId);
  if (clash) {
    throw new CheckoutPageError(
      `The slug "${input.slug}" is already used by another checkout page.`,
      409,
    );
  }
}
