import "server-only";

import type { Firestore } from "firebase-admin/firestore";

import {
  DOWNLOAD_LABEL_MAX,
  PUBLIC_DESCRIPTION_MAX,
  productSlugError,
  sellOnlineGateOn,
  sellOnlinePriceError,
  slugifyProductSlug,
} from "@/lib/products/sell-online";
import { isDocId } from "@/lib/server/doc-id";
import { chooseProductPayRail } from "@/lib/products/pay-rail";
import { isSafeSocialUrl } from "@/lib/website/premium";
import type { Product, ProductDelivery } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Validates the Sell Online fields of a product create/PATCH. Format checks
 * plus the ones that need Firestore: slug uniqueness (against other products
 * and the sub-account's checkout pages), community group/course and checkout
 * page ownership.
 *
 * Gate rule: with the gate off, sell-online values that equal what is stored
 * are ignored (a UI that round-trips the whole product keeps working after the
 * agency turns the gate off). The one change allowed with the gate off is
 * taking a product off sale (`sellOnline: false`); any other change answers
 * 403 `gate_off`.
 *
 * While a product is (or becomes) sold online its price must be a whole
 * number of cents above zero and under the cap, in an allowed currency, and
 * turning it on or changing its currency needs a ready pay rail
 * (`chooseProductPayRail`).
 */

export class SellOnlineError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export const SELL_KEYS = [
  "sellOnline",
  "slug",
  "publicDescription",
  "checkoutPageId",
  "delivery",
] as const;
type SellKey = (typeof SELL_KEYS)[number];

/** Fields that change what the website or buy link shows. */
const PUBLIC_KEYS = [
  "name",
  "description",
  "unitPriceCents",
  "currency",
  "active",
  ...SELL_KEYS,
] as const;

/** Key-order independent: Firestore returns map keys sorted, the body doesn't. */
function canonical(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined && x !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** What an absent field means, so "absent" and its explicit default compare equal. */
const SELL_DEFAULTS: Partial<Pick<Product, SellKey>> = {
  sellOnline: false,
  publicDescription: "",
  checkoutPageId: null,
  delivery: { type: "none" },
};

function parseDelivery(raw: unknown): ProductDelivery {
  if (!raw || typeof raw !== "object") {
    throw new SellOnlineError("Invalid delivery.", 400);
  }
  const d = raw as Record<string, unknown>;
  if (d.type === "none") return { type: "none" };
  if (d.type === "community") {
    const groupId =
      typeof d.communityGroupId === "string" ? d.communityGroupId.trim() : "";
    if (!groupId) {
      throw new SellOnlineError("Pick the community group the buyer joins.", 400);
    }
    const courseId =
      typeof d.courseId === "string" && d.courseId.trim()
        ? d.courseId.trim()
        : null;
    if (!isDocId(groupId) || (courseId && !isDocId(courseId))) {
      throw new SellOnlineError("Invalid community group or course.", 400);
    }
    return { type: "community", communityGroupId: groupId, courseId };
  }
  if (d.type === "download") {
    const url = typeof d.url === "string" ? d.url.trim() : "";
    // Emailed and shown to the buyer: a plain public https URL only.
    if (!isSafeSocialUrl(url)) {
      throw new SellOnlineError("The download link must be a public https:// URL.", 400);
    }
    const label =
      typeof d.label === "string" && d.label.trim()
        ? d.label.trim().slice(0, DOWNLOAD_LABEL_MAX)
        : undefined;
    return label ? { type: "download", url, label } : { type: "download", url };
  }
  throw new SellOnlineError("Unknown delivery type.", 400);
}

/** Pulls the sell-online keys out of a request body, format-checked only. */
export function parseSellOnlineBody(
  body: Record<string, unknown>,
): Partial<Pick<Product, SellKey>> {
  const out: Partial<Pick<Product, SellKey>> = {};
  if (typeof body.sellOnline === "boolean") out.sellOnline = body.sellOnline;
  if (typeof body.slug === "string") {
    const slug = slugifyProductSlug(body.slug);
    const err = productSlugError(slug);
    if (err) throw new SellOnlineError(err, 400);
    out.slug = slug;
  }
  if (typeof body.publicDescription === "string") {
    out.publicDescription = body.publicDescription
      .trim()
      .slice(0, PUBLIC_DESCRIPTION_MAX);
  }
  if (body.checkoutPageId === null) out.checkoutPageId = null;
  else if (typeof body.checkoutPageId === "string") {
    const id = body.checkoutPageId.trim();
    if (id && !isDocId(id)) {
      throw new SellOnlineError("Invalid checkout page.", 400);
    }
    out.checkoutPageId = id || null;
  }
  if (body.delivery !== undefined) out.delivery = parseDelivery(body.delivery);
  return out;
}

/** Which slug owner blocks `slug`, or null when it is free. */
async function slugTakenBy(
  db: Firestore,
  subAccountId: string,
  slug: string,
  exceptProductId: string | null,
): Promise<"product" | "checkout_page" | null> {
  const [products, pages] = await Promise.all([
    db
      .collection("products")
      .where("subAccountId", "==", subAccountId)
      .where("slug", "==", slug)
      .limit(2)
      .get(),
    db
      .collection(`subAccounts/${subAccountId}/checkoutPages`)
      .where("slug", "==", slug)
      .limit(1)
      .get(),
  ]);
  if (products.docs.some((d) => d.id !== exceptProductId)) return "product";
  if (!pages.empty) return "checkout_page";
  return null;
}

async function mintSlug(
  db: Firestore,
  subAccountId: string,
  name: string,
  productId: string | null,
): Promise<string> {
  const base = slugifyProductSlug(name) || "product";
  const root = base.length < 2 ? `${base}-item` : base;
  let slug = root;
  for (let i = 2; i <= 30; i++) {
    if (!productSlugError(slug) && !(await slugTakenBy(db, subAccountId, slug, productId))) {
      return slug;
    }
    slug = `${root.slice(0, 55)}-${i}`;
  }
  return `${root.slice(0, 50)}-${Date.now().toString(36)}`;
}

async function checkDeliveryTargets(
  db: Firestore,
  subAccountId: string,
  sub: Partial<SubAccountDoc>,
  delivery: ProductDelivery,
): Promise<void> {
  if (delivery.type !== "community") return;
  if (sub.communityEnabledByAgency !== true) {
    throw new SellOnlineError(
      "Community isn't turned on for this workspace, so it can't be a delivery.",
      400,
    );
  }
  const groupRef = db.doc(
    `subAccounts/${subAccountId}/communityGroups/${delivery.communityGroupId}`,
  );
  const group = await groupRef.get();
  if (!group.exists) {
    throw new SellOnlineError("That community group doesn't exist.", 400);
  }
  if (delivery.courseId) {
    const course = await groupRef.collection("courses").doc(delivery.courseId).get();
    if (!course.exists) {
      throw new SellOnlineError("That course isn't in the chosen group.", 400);
    }
  }
}

async function checkCheckoutPage(
  db: Firestore,
  subAccountId: string,
  pageId: string,
  productId: string | null,
): Promise<void> {
  if (!productId) {
    throw new SellOnlineError("Save the product before linking a checkout page.", 400);
  }
  const page = await db
    .doc(`subAccounts/${subAccountId}/checkoutPages/${pageId}`)
    .get();
  if (!page.exists) {
    throw new SellOnlineError("That checkout page doesn't exist.", 400);
  }
  const data = page.data() ?? {};
  if (data.productId !== productId) {
    throw new SellOnlineError("That checkout page sells a different product.", 400);
  }
  if (data.status !== "published") {
    throw new SellOnlineError("Publish that checkout page first.", 400);
  }
}

export interface SellOnlineUpdateInput {
  db: Firestore;
  subAccountId: string;
  sub: Partial<SubAccountDoc>;
  /** Null when creating. */
  productId: string | null;
  existing: Partial<Product> | null;
  /** Non-sell fields already sanitized for this write. */
  baseUpdates: Partial<Product>;
  body: Record<string, unknown>;
}

/**
 * Returns the sell-online fields to write (possibly empty) plus a
 * publicVersion bump when a public-facing field changed on a product that is,
 * or was, sold online. Throws SellOnlineError on a refusal.
 */
export async function prepareSellOnlineUpdate(
  input: SellOnlineUpdateInput,
): Promise<Partial<Product>> {
  const { db, subAccountId, sub, productId, existing, baseUpdates } = input;
  const parsed = parseSellOnlineBody(input.body);

  const changed: Partial<Pick<Product, SellKey>> = {};
  for (const key of SELL_KEYS) {
    if (!(key in parsed)) continue;
    const value = parsed[key];
    const stored = existing?.[key] ?? SELL_DEFAULTS[key];
    if (!same(value, stored)) {
      (changed as Record<string, unknown>)[key] = value;
    }
  }

  const out: Partial<Product> = {};
  if (Object.keys(changed).length > 0) {
    const onlyTakingOffSale =
      changed.sellOnline === false && Object.keys(changed).length === 1;
    if (!sellOnlineGateOn(sub) && !onlyTakingOffSale) {
      throw new SellOnlineError(
        "Selling online is turned off for this workspace. Ask your agency owner.",
        403,
        "gate_off",
      );
    }
    if (changed.slug) {
      const takenBy = await slugTakenBy(db, subAccountId, changed.slug, productId);
      if (takenBy === "product") {
        throw new SellOnlineError("Another product already uses that URL slug.", 409);
      }
      if (takenBy === "checkout_page") {
        throw new SellOnlineError("A checkout page in this workspace already uses that URL slug.", 409);
      }
    }
    if (changed.delivery) {
      await checkDeliveryTargets(db, subAccountId, sub, changed.delivery);
    }
    if (changed.checkoutPageId) {
      await checkCheckoutPage(db, subAccountId, changed.checkoutPageId, productId);
    }
    Object.assign(out, changed);
  }

  const nowOnline = (out.sellOnline ?? existing?.sellOnline) === true;
  if (nowOnline) {
    const price = baseUpdates.unitPriceCents ?? existing?.unitPriceCents;
    const currency = baseUpdates.currency ?? existing?.currency ?? "USD";
    const priceErr = sellOnlinePriceError(price, currency);
    if (priceErr) throw new SellOnlineError(priceErr, 400);
    const currencyChanged =
      baseUpdates.currency !== undefined && baseUpdates.currency !== existing?.currency;
    if (changed.sellOnline === true || currencyChanged) {
      const rail = chooseProductPayRail(sub, currency);
      if (!rail.ok) throw new SellOnlineError(rail.reason, 400, "no_pay_rail");
    }
  }

  if (nowOnline && !(out.slug ?? existing?.slug)) {
    const name = baseUpdates.name ?? existing?.name ?? "product";
    out.slug = await mintSlug(db, subAccountId, name, productId);
  }

  const wasOnline = existing?.sellOnline === true;
  if (existing && (wasOnline || nowOnline)) {
    const merged = { ...baseUpdates, ...out } as Record<string, unknown>;
    const stored = existing as Record<string, unknown>;
    const publicChange = PUBLIC_KEYS.some(
      (k) =>
        k in merged &&
        !same(merged[k], stored[k] ?? (SELL_DEFAULTS as Record<string, unknown>)[k]),
    );
    if (publicChange) out.publicVersion = (existing.publicVersion ?? 0) + 1;
  }

  return out;
}
