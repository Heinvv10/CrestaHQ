import type { Timestamp, FieldValue } from "firebase/firestore";
import type { FormAppearance } from "@/types/forms";

/**
 * Funnels — Labs experiment (Payments v1 follow-on).
 *
 * A funnel is CONTENT + SEQUENCING wrapped around the existing checkout. It
 * deliberately owns no payment code: its offer step REFERENCES a
 * `checkoutPages` doc, so order bumps, the reconciler, refunds and the
 * Payments report all work on day one and there is exactly one money path in
 * the codebase. Do not add a second one here.
 *
 * Three steps, fixed, in this order:
 *   1. landing  — the pitch (headline, bullets, optional video, CTA)
 *   2. offer    — the linked checkout page at /co/[saId]/[slug], or a plain
 *                 URL for lead-gen funnels with nothing to sell
 *   3. thanks   — post-conversion message, optional redirect
 *
 * Lives at `subAccounts/{id}/funnels/{funnelId}`, public at
 * `/fn/[subAccountId]/[slug]` — same self-hosted model as community groups
 * and booking pages. No custom domains; that's platform-wide work.
 *
 * EXPERIMENTAL: this is a Labs resident and may be withdrawn. Keep it
 * self-contained — the only thing it reaches into is a checkout page id.
 */

export type FunnelTemplateKey = "simple_offer" | "vsl" | "lead_magnet";

export interface FunnelLanding {
  headline: string;
  subheadline: string;
  /** Short benefit lines. Rendered as a checklist. Max 6. */
  bullets: string[];
  /** Embed URL, already normalised + host-checked. Null = no video. */
  videoUrl: string | null;
  /** Hero image URL (https only). Null = no image. */
  imageUrl: string | null;
  ctaLabel: string;
}

/** Every section type in the library. See lib/funnels/sections.ts. */
export type FunnelSectionType =
  | "hero"
  | "video"
  | "benefits"
  | "features"
  | "testimonials"
  | "faq"
  | "offer"
  | "guarantee"
  | "bio"
  | "logos"
  | "urgency"
  | "text"
  | "image"
  | "cta"
  // ── added in the contrast upgrade ──
  /** Numbered how-it-works. */
  | "steps"
  /** Big-number band. Real figures only. */
  | "stats"
  /** With-us vs without-us, two columns. */
  | "comparison"
  /** Oversized pull quote. */
  | "pullquote"
  /** Long-form first-person narrative — the spine of a real sales page. */
  | "story"
  /** Priced tiers with compare-at and scarcity. */
  | "pricing";

/** Generic repeater row — a bullet, feature, testimonial, FAQ pair or logo. */
export interface FunnelSectionItem {
  /** Bullet text / feature name / question / quote. */
  title: string;
  /** Description / answer / attribution. */
  body: string;
  /** Free slot: role+company on a testimonial, image URL on a logo. */
  meta: string;
  /** Avatar / icon / tier image. https only. */
  imageUrl?: string | null;
  /** 1-5 stars on a testimonial. Null hides the row. */
  rating?: number | null;
  /** The outcome, called out separately — "↑ $50K/mo in 60 days".
   *  Only ever a real, supplied result; never model-invented. */
  result?: string;
}

/**
 * ONE shape for every section type — see lib/funnels/sections.ts for why.
 * Unused fields stay empty; SECTION_META declares which the editor shows.
 */
export interface FunnelSection {
  id: string;
  type: FunnelSectionType;
  heading: string;
  subheading: string;
  /** Newlines preserved on render. */
  body: string;
  items: FunnelSectionItem[];
  /** Normalised video embed URL, or an https image URL. */
  mediaUrl: string | null;
  ctaLabel: string;
  /** ISO datetime for urgency sections. */
  deadline: string | null;
  /** Band behind this section. Absent on pre-upgrade docs → "default". */
  background?: FunnelSectionBackground;
  /** Left-aligned long-form instead of centred. Story sections default on. */
  alignLeft?: boolean;
  /** Struck-through anchor price, e.g. "Normally $1,997". */
  compareAt?: string;
  /** 0-100. Renders a sold-out bar. Only use a real number. */
  scarcityPercent?: number | null;
  /** Byline on a story section, e.g. "From: Jane Doe". */
  attribution?: string;
  /** Eyebrow pill above a hero/CTA heading — "For serious lifters",
   *  "September 21-23 · Las Vegas". Short and TRUE. */
  badge?: string;
  /** Hero only: render the image as a full-bleed background under a dark
   *  overlay instead of an inline photo. The leading-builder hero look. */
  mediaAsBackground?: boolean;
  /**
   * What the image should show, in words. Set by the AI drafter so the
   * operator can re-run a stock search or brief a designer, and kept after
   * mediaUrl is filled so swapping the picture stays easy.
   */
  imageQuery?: string;
}

/**
 * Full-bleed background band behind a section. This is what makes a funnel
 * page read as designed rather than as a document — alternating dark / light /
 * accent bands give the eye somewhere to break.
 *
 * The band spans the viewport; content inside stays in a max-width container.
 * Assigned automatically on add (alternating), overridable per section.
 */
export type FunnelSectionBackground =
  | "default"
  | "muted"
  | "dark"
  | "accent"
  | "accentSoft";

export const MAX_FUNNEL_SECTIONS = 30;
export const MAX_SECTION_ITEMS = 12;

/**
 * Page-level look. This is what separates a designed funnel from a document:
 * FHL runs a 70px condensed heading against 17px body. System-ui at 40px
 * reads as a form, no matter how good the copy is.
 */
export interface FunnelStyle {
  fontPair: FunnelFontPair;
  /** Multiplier on every heading size. 1 = base, 1.25 = big, 0.85 = compact. */
  headingScale: number;
  uppercaseHeadings: boolean;
  /** Content column width in px. Wider suits image-heavy pages. */
  contentWidth: number;
}

export type FunnelFontPair =
  | "system"
  | "condensed"
  | "editorial"
  | "geometric"
  | "classic";

export function defaultFunnelStyle(): FunnelStyle {
  return {
    // Condensed by default: it's the closest to how high-converting sales
    // pages actually look, and the old system-ui default was the single
    // biggest reason the first pages read as plain documents.
    fontPair: "condensed",
    headingScale: 1.15,
    uppercaseHeadings: false,
    contentWidth: 780,
  };
}

export interface FunnelThanks {
  headline: string;
  body: string;
  /** Optional external redirect after a short delay. https only. */
  redirectUrl: string | null;
}

export interface Funnel {
  id: string;

  // ── Tenancy ───────────────────────────────────────────────────────
  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  slug: string;
  name: string;
  status: "draft" | "published";
  template: FunnelTemplateKey;

  /**
   * LEGACY — the flat pre-section-library shape. Kept so existing funnels
   * keep rendering: when `sections` is empty the renderer synthesises
   * sections from this (lib/funnels/sections.ts::sectionsFromLegacyLanding).
   * New funnels write `sections` and leave this at its defaults.
   */
  landing: FunnelLanding;

  /** The page, in order. Empty on pre-section-library funnels. */
  sections: FunnelSection[];

  /**
   * Product this funnel sells, when the operator picked a product directly
   * instead of an existing checkout page. The funnel still doesn't own
   * payment — saving with a productId CREATES a real checkout page and
   * stores its id in `checkoutPageId`. This field is kept so the editor can
   * show what was chosen.
   */
  productId: string | null;

  /**
   * The checkout page this funnel sells. Null for a lead-gen funnel, in which
   * case `ctaUrl` is used instead. Never inlines a price — the checkout page
   * remains the single source of truth for what is charged.
   */
  checkoutPageId: string | null;
  /** Where the CTA goes when there's no checkout page. https only. */
  ctaUrl: string | null;

  /**
   * Optional vanity host: `{subdomain}.{app domain}` serves this funnel at its
   * root. GLOBALLY unique across the deployment (slugs are only per-sub-account)
   * — authority lives in the server-only `funnelSubdomains/{name}` claim
   * collection, not here; this field is display/back-reference.
   */
  subdomain?: string | null;

  thanks: FunnelThanks;
  appearance: FormAppearance;
  /** Absent on pre-upgrade docs → defaultFunnelStyle(). */
  style?: FunnelStyle;
  /** Sticky bottom CTA bar on the public page. */
  stickyCta?: boolean;
  /** Second line inside every CTA button — "Starts Monday · 12 spots". */
  ctaSubtitle?: string;
  /**
   * Thin accent announcement bar above the hero — "Doors close Friday",
   * "Next cohort starts March 3". Rendered only when non-empty, so the
   * toggle IS the text: clear it to turn it off. No separate boolean —
   * an enabled-but-empty banner (or worse, enabled placeholder text) is
   * a publishable accident waiting to happen.
   */
  topBanner?: string;

  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;
}

export const MAX_FUNNEL_BULLETS = 6;

/** Same slug rules as checkout pages — it's the public URL segment. */
export function slugifyFunnelSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const RESERVED = new Set(["api", "new", "thanks", "preview"]);

export function funnelSlugError(slug: string): string | null {
  if (!slug) return "Add a URL slug.";
  if (slug.length < 2) return "Slug must be at least 2 characters.";
  if (RESERVED.has(slug)) return `"${slug}" is reserved — pick another.`;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return "Use lowercase letters, numbers and hyphens (can't start or end with a hyphen).";
  }
  return null;
}
