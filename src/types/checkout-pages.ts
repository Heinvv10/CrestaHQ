import type { Timestamp, FieldValue } from "firebase/firestore";
import type { FormField, FormAppearance } from "@/types/forms";
import type { PipelineStageId } from "@/types/deals";

/**
 * Checkout pages — Payments v1.
 *
 * One public page per offer at `/co/[subAccountId]/[slug]`: the main product,
 * up to 3 order bumps, and the fields collected before the buyer is handed to
 * Stripe. This is where bumps live — Stripe's hosted Checkout can't express
 * "tick this to add X", which is exactly why we own the page before it and let
 * Stripe own the card fields after it.
 *
 * Subcollection (`subAccounts/{id}/checkoutPages/{pageId}`), NOT top-level —
 * these are configuration, like `bookingPages`, not documents-with-a-lifecycle
 * like `orders` or `quotes`.
 *
 * Deliberately reuses the forms primitives (`FormField`, `FormAppearance`) so
 * capture and theming behave identically to `/f/[formId]` — including the
 * `mapsTo` contact mapping and the SMS-consent field type.
 */

export const MAX_BUMPS_PER_CHECKOUT_PAGE = 3;

export interface CheckoutPage {
  id: string;

  // ── Tenancy ───────────────────────────────────────────────────────
  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  /** URL segment. Unique per sub-account; lowercase kebab. */
  slug: string;
  /** Internal label, never shown to buyers. */
  name: string;
  /** Draft pages 404 publicly — same published/draft model as booking pages. */
  status: "draft" | "published";

  /** The main offer. Snapshotted into the order at checkout. */
  productId: string;
  /**
   * Order bumps, rendered as checkboxes under the summary. Each must be an
   * ACTIVE, `bumpEligible` product in the SAME currency as the main offer —
   * Stripe Checkout can't mix currencies in one session.
   */
  bumpProductIds: string[];

  headline: string;
  subheadline: string;

  /** Fields collected before checkout. Reuses the form field model. */
  collectFields: FormField[];
  /** Applied to the contact created/matched at checkout. */
  autoTags: string[];
  pipelineStageId: PipelineStageId | null;

  /** Where Stripe returns the buyer. Null = our own thanks page. */
  successUrl: string | null;

  appearance: FormAppearance;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

/** Slugify a page name the same way on the client (preview) and server
 *  (authoritative), so what the operator sees is what gets saved. */
export function slugifyCheckoutSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Reserved so a page can never shadow a sibling route under /co. */
const RESERVED_SLUGS = new Set(["api", "new", "thanks", "preview"]);

export function checkoutSlugError(slug: string): string | null {
  if (!slug) return "Add a URL slug.";
  if (slug.length < 2) return "Slug must be at least 2 characters.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved — pick another.`;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return "Use lowercase letters, numbers and hyphens (can't start or end with a hyphen).";
  }
  return null;
}
