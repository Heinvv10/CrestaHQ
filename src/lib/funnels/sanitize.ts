import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { normaliseVideoUrl } from "@/lib/funnels/video";
import {
  MAX_FUNNEL_BULLETS,
  MAX_FUNNEL_SECTIONS,
  MAX_SECTION_ITEMS,
  funnelSlugError,
  slugifyFunnelSlug,
  type Funnel,
  type FunnelSection,
  type FunnelSectionBackground,
  type FunnelSectionType,
} from "@/types/funnels";
import { sectionMeta } from "@/lib/funnels/sections";
import { defaultFormAppearance } from "@/types/forms";

/**
 * Funnel payload sanitizer + validator (Labs experiment).
 *
 * In lib/ because Next 15 forbids non-handler exports from route files and
 * both the collection and `[funnelId]` routes need it — same reason
 * lib/checkout/sanitize.ts and lib/products/sanitize.ts exist.
 */

export class FunnelError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "FunnelError";
    this.status = status;
  }
}

export interface FunnelPayload {
  name?: string;
  slug?: string;
  status?: "draft" | "published";
  template?: Funnel["template"];
  landing?: Partial<Funnel["landing"]> & { videoUrl?: string | null };
  checkoutPageId?: string | null;
  ctaUrl?: string | null;
  sections?: unknown;
  productId?: string | null;
  style?: Partial<Funnel["style"]>;
  stickyCta?: boolean;
  ctaSubtitle?: string;
  topBanner?: string;
  subdomain?: string | null;
  thanks?: Partial<Funnel["thanks"]>;
  appearance?: Partial<Funnel["appearance"]>;
}

function httpsOrNull(raw: unknown, field: string): string | null {
  const v = (raw ?? "").toString().trim();
  if (!v) return null;
  if (!/^https:\/\//i.test(v)) {
    throw new FunnelError(`${field} must start with https://`);
  }
  return v.slice(0, 500);
}

export function sanitizeFunnelPayload(body: FunnelPayload): Partial<Funnel> {
  const out: Partial<Funnel> = {};

  if (typeof body.name === "string") out.name = body.name.trim().slice(0, 120);
  if (typeof body.slug === "string") out.slug = slugifyFunnelSlug(body.slug);
  if (body.status === "draft" || body.status === "published") {
    out.status = body.status;
  }
  if (
    body.template === "simple_offer" ||
    body.template === "vsl" ||
    body.template === "lead_magnet"
  ) {
    out.template = body.template;
  }

  if (body.landing) {
    const l = body.landing;
    // Rejected rather than passed through — see lib/funnels/video.ts. An
    // unrecognised host must not end up in an iframe on a page we host.
    let videoUrl: string | null = null;
    const rawVideo = (l.videoUrl ?? "").toString().trim();
    if (rawVideo) {
      const embed = normaliseVideoUrl(rawVideo);
      if (!embed) {
        throw new FunnelError(
          "That video link isn't supported. Use a YouTube, Vimeo, Loom or Wistia URL.",
        );
      }
      videoUrl = embed.url;
    }

    out.landing = {
      headline: (l.headline ?? "").toString().trim().slice(0, 160),
      subheadline: (l.subheadline ?? "").toString().trim().slice(0, 400),
      bullets: Array.isArray(l.bullets)
        ? l.bullets
            .map((b) => String(b).trim().slice(0, 160))
            .filter(Boolean)
            .slice(0, MAX_FUNNEL_BULLETS)
        : [],
      videoUrl,
      imageUrl: httpsOrNull(l.imageUrl, "Image URL"),
      ctaLabel: (l.ctaLabel ?? "").toString().trim().slice(0, 60) || "Continue",
    };
  }

  if (body.sections !== undefined) {
    out.sections = sanitizeSections(body.sections);
  }
  if (body.productId !== undefined) {
    out.productId = body.productId ? String(body.productId).trim() : null;
  }
  if (body.checkoutPageId !== undefined) {
    out.checkoutPageId = body.checkoutPageId
      ? String(body.checkoutPageId).trim()
      : null;
  }
  if (body.ctaUrl !== undefined) {
    out.ctaUrl = httpsOrNull(body.ctaUrl, "CTA link");
  }

  if (body.thanks) {
    out.thanks = {
      headline:
        (body.thanks.headline ?? "").toString().trim().slice(0, 160) ||
        "Thank you",
      body: (body.thanks.body ?? "").toString().trim().slice(0, 800),
      redirectUrl: httpsOrNull(body.thanks.redirectUrl, "Redirect URL"),
    };
  }

  if (body.style) {
    const st = body.style;
    const pair = String(st.fontPair ?? "");
    out.style = {
      fontPair: (["system", "condensed", "editorial", "geometric", "classic"].includes(
        pair,
      )
        ? pair
        : "condensed") as NonNullable<Funnel["style"]>["fontPair"],
      // Clamped so a bad value can't produce unreadable or comical type.
      headingScale: Math.min(
        Math.max(Number(st.headingScale) || 1.15, 0.7),
        1.8,
      ),
      uppercaseHeadings: st.uppercaseHeadings === true,
      contentWidth: Math.min(
        Math.max(Math.round(Number(st.contentWidth) || 780), 560),
        1100,
      ),
    };
  }
  if (body.stickyCta !== undefined) out.stickyCta = body.stickyCta === true;
  if (body.ctaSubtitle !== undefined) {
    out.ctaSubtitle = String(body.ctaSubtitle).trim().slice(0, 80);
  }
  if (body.topBanner !== undefined) {
    out.topBanner = String(body.topBanner).trim().slice(0, 120);
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

const SECTION_TYPES = new Set<FunnelSectionType>([
  "hero", "video", "benefits", "features", "testimonials", "faq", "offer",
  "guarantee", "bio", "logos", "urgency", "text", "image", "cta",
  "steps", "stats", "comparison", "pullquote", "story", "pricing",
]);

const BACKGROUNDS = new Set<FunnelSectionBackground>([
  "default", "muted", "dark", "accent", "accentSoft",
]);

/**
 * Sanitize the section list.
 *
 * Media is validated PER SECTION TYPE rather than by sniffing the value: a
 * "video" section runs the host allow-list (an arbitrary URL would end up in
 * an iframe on a page we host), everything else takes an https image URL. A
 * bad video link is dropped rather than rejecting the whole save — the
 * operator is mid-edit on a 20-section page and losing it all would be worse.
 */
function sanitizeSections(raw: unknown): FunnelSection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_FUNNEL_SECTIONS)
    .map((r, i) => {
      const sec = (r ?? {}) as Partial<FunnelSection>;
      const type = (
        SECTION_TYPES.has(sec.type as FunnelSectionType) ? sec.type : "text"
      ) as FunnelSectionType;
      const meta = sectionMeta(type);

      let mediaUrl: string | null = null;
      const rawMedia = (sec.mediaUrl ?? "").toString().trim();
      if (rawMedia) {
        if (meta.uses.media === "video") {
          mediaUrl = normaliseVideoUrl(rawMedia)?.url ?? null;
        } else if (/^https:\/\//i.test(rawMedia)) {
          mediaUrl = rawMedia.slice(0, 500);
        }
      }

      return {
        id:
          typeof sec.id === "string" && sec.id ? sec.id.slice(0, 40) : `s${i}`,
        type,
        heading: (sec.heading ?? "").toString().trim().slice(0, 160),
        subheading: (sec.subheading ?? "").toString().trim().slice(0, 400),
        body: (sec.body ?? "").toString().trim().slice(0, 2_000),
        items: Array.isArray(sec.items)
          ? sec.items
              .slice(0, MAX_SECTION_ITEMS)
              .map((it) => {
                const row = (it ?? {}) as unknown as Record<string, unknown>;
                const img = String(row.imageUrl ?? "").trim();
                const rating = Number(row.rating);
                return {
                  title: String(row.title ?? "").trim().slice(0, 200),
                  body: String(row.body ?? "").trim().slice(0, 800),
                  meta: String(row.meta ?? "").trim().slice(0, 300),
                  imageUrl: /^https:\/\//i.test(img) ? img.slice(0, 500) : null,
                  rating:
                    Number.isFinite(rating) && rating > 0
                      ? Math.min(5, Math.round(rating))
                      : null,
                  result: String(row.result ?? "").trim().slice(0, 80),
                };
              })
              // Drop fully-empty rows so the page doesn't render blanks.
              .filter((it) => it.title || it.body || it.meta)
          : [],
        mediaUrl,
        ctaLabel: (sec.ctaLabel ?? "").toString().trim().slice(0, 60),
        deadline:
          typeof sec.deadline === "string" && sec.deadline
            ? sec.deadline.slice(0, 40)
            : null,
        background: BACKGROUNDS.has(sec.background as FunnelSectionBackground)
          ? (sec.background as FunnelSectionBackground)
          : "default",
        imageQuery: (sec.imageQuery ?? "").toString().trim().slice(0, 120),
        alignLeft: sec.alignLeft === true,
        compareAt: (sec.compareAt ?? "").toString().trim().slice(0, 80),
        scarcityPercent:
          typeof sec.scarcityPercent === "number" &&
          Number.isFinite(sec.scarcityPercent)
            ? Math.min(100, Math.max(0, Math.round(sec.scarcityPercent)))
            : null,
        attribution: (sec.attribution ?? "").toString().trim().slice(0, 120),
        badge: (sec.badge ?? "").toString().trim().slice(0, 60),
        mediaAsBackground: sec.mediaAsBackground === true,
      } satisfies FunnelSection;
    })
    // A section with nothing in it renders as dead space.
    .filter(
      (s) =>
        s.heading ||
        s.subheading ||
        s.body ||
        s.items.length ||
        s.mediaUrl ||
        s.ctaLabel,
    );
}

/** Slug must be unique per sub-account — it's the public URL. */
export async function assertFunnelSlugAvailable(input: {
  subAccountId: string;
  slug: string;
  exceptFunnelId?: string;
}): Promise<void> {
  const err = funnelSlugError(input.slug);
  if (err) throw new FunnelError(err);

  const snap = await getAdminDb()
    .collection(`subAccounts/${input.subAccountId}/funnels`)
    .where("slug", "==", input.slug)
    .limit(2)
    .get();

  if (snap.docs.some((d) => d.id !== input.exceptFunnelId)) {
    throw new FunnelError(
      `The slug "${input.slug}" is already used by another funnel.`,
      409,
    );
  }
}

/**
 * A published funnel must have somewhere for its CTA to go, and if that's a
 * checkout page it must be a real, PUBLISHED one in this sub-account.
 *
 * Checked at publish time rather than save time so drafts can be
 * half-finished, and re-checked on every publish so a funnel can't keep
 * pointing at a checkout page that was later unpublished or deleted.
 */
export async function assertFunnelPublishable(input: {
  subAccountId: string;
  checkoutPageId: string | null;
  ctaUrl: string | null;
}): Promise<void> {
  if (!input.checkoutPageId && !input.ctaUrl) {
    throw new FunnelError(
      "Pick a checkout page or set a CTA link before publishing — the button needs somewhere to go.",
    );
  }
  if (!input.checkoutPageId) return;

  const snap = await getAdminDb()
    .doc(
      `subAccounts/${input.subAccountId}/checkoutPages/${input.checkoutPageId}`,
    )
    .get();
  if (!snap.exists) {
    throw new FunnelError("That checkout page no longer exists.");
  }
  if (snap.data()?.status !== "published") {
    throw new FunnelError(
      "That checkout page is still a draft. Publish it first, or the funnel's buy button would 404.",
    );
  }
}
