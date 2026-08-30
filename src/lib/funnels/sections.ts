import type {
  FunnelLanding,
  FunnelSection,
  FunnelSectionBackground,
  FunnelSectionType,
} from "@/types/funnels";

/**
 * Funnel section library.
 *
 * ONE section shape covers every type rather than a 14-member discriminated
 * union. `items[]` is the generic repeater (bullets, features, testimonials,
 * FAQ rows, logos) and the scalar fields cover the rest. That keeps the
 * sanitizer, the editor and the renderer to a single switch each — the
 * alternative was ~14 near-identical validators, which is where this kind of
 * builder normally rots.
 *
 * Adding a section type: add it to FunnelSectionType, add a SECTION_META
 * entry, add a default here, and add a case to the renderer. Nothing else.
 */

export interface SectionMeta {
  type: FunnelSectionType;
  label: string;
  hint: string;
  /** Which fields the editor shows — keeps the form honest per type. */
  uses: {
    heading?: boolean;
    subheading?: boolean;
    body?: boolean;
    items?:
      | "bullets"
      | "features"
      | "testimonials"
      | "faq"
      | "logos"
      | "steps"
      | "stats"
      | "comparison"
      | "pricing";
    media?: "video" | "image";
    cta?: boolean;
    deadline?: boolean;
  };
}

export const SECTION_META: SectionMeta[] = [
  {
    type: "hero",
    label: "Hero",
    hint: "The promise at the top of the page.",
    uses: { heading: true, subheading: true, media: "image", cta: true },
  },
  {
    type: "video",
    label: "Video",
    hint: "YouTube, Vimeo, Loom or Wistia.",
    uses: { heading: true, media: "video" },
  },
  {
    type: "benefits",
    label: "Benefits",
    hint: "Checklist of outcomes.",
    uses: { heading: true, items: "bullets" },
  },
  {
    type: "features",
    label: "Feature grid",
    hint: "What's included, in a grid.",
    uses: { heading: true, subheading: true, items: "features" },
  },
  {
    type: "testimonials",
    label: "Testimonials",
    hint: "Real quotes from real customers — only add ones you actually have.",
    uses: { heading: true, items: "testimonials" },
  },
  {
    type: "faq",
    label: "FAQ",
    hint: "Handle the objections before the button.",
    uses: { heading: true, items: "faq" },
  },
  {
    type: "offer",
    label: "Offer summary",
    hint: "Recap what they get, then the button.",
    uses: { heading: true, subheading: true, items: "bullets", cta: true },
  },
  {
    type: "guarantee",
    label: "Guarantee",
    hint: "Only state a guarantee you will actually honour.",
    uses: { heading: true, body: true },
  },
  {
    type: "bio",
    label: "About / bio",
    hint: "Who's behind this.",
    uses: { heading: true, body: true, media: "image" },
  },
  {
    type: "logos",
    label: "Social proof strip",
    hint: "Names or logos you're genuinely associated with.",
    uses: { heading: true, items: "logos" },
  },
  {
    type: "urgency",
    label: "Urgency",
    hint: "A real deadline. Don't fake scarcity.",
    uses: { heading: true, body: true, deadline: true },
  },
  {
    type: "text",
    label: "Text block",
    hint: "Free paragraph. Line breaks are kept.",
    uses: { heading: true, body: true },
  },
  {
    type: "image",
    label: "Image",
    hint: "Full-width image — or a photo band with one overlay line.",
    uses: { heading: true, media: "image", body: true },
  },
  {
    type: "cta",
    label: "Call to action",
    hint: "Repeat the button further down the page.",
    uses: { heading: true, subheading: true, cta: true },
  },
  {
    type: "steps",
    label: "How it works",
    hint: "Numbered steps. Removes 'what actually happens if I buy?'",
    uses: { heading: true, subheading: true, items: "steps" },
  },
  {
    type: "stats",
    label: "Numbers",
    hint: "Big figures. Only ones you can actually stand behind.",
    uses: { heading: true, items: "stats" },
  },
  {
    type: "comparison",
    label: "Before / after",
    hint: "Two columns — life without this, life with it.",
    uses: { heading: true, subheading: true, items: "comparison" },
  },
  {
    type: "pullquote",
    label: "Pull quote",
    hint: "One oversized line to break up the page.",
    uses: { body: true },
  },
  {
    type: "story",
    label: "Story",
    hint: "Long-form, first person, left-aligned. The spine of a real sales page.",
    uses: {
      heading: true,
      subheading: true,
      body: true,
      media: "image",
      cta: false,
    },
  },
  {
    type: "pricing",
    label: "Pricing tiers",
    hint: "Priced options with what's included. Real prices only.",
    uses: { heading: true, subheading: true, items: "pricing", cta: true },
  },
];

/**
 * Default band for each type, and the alternating rhythm.
 *
 * Some sections have a fixed band because their whole job is to interrupt
 * (pullquote, stats, urgency); the rest alternate so no two neighbours share a
 * background. Without this every page comes out as one flat colour, which is
 * exactly how the first version looked.
 */
const FIXED_BACKGROUND: Partial<Record<FunnelSectionType, FunnelSectionBackground>> = {
  hero: "dark",
  pullquote: "dark",
  stats: "accent",
  urgency: "accentSoft",
  offer: "default",
  pricing: "muted",
  guarantee: "accentSoft",
  cta: "dark",
  story: "default",
};

const ALTERNATING: FunnelSectionBackground[] = ["default", "muted"];

/** Assign bands across a whole page so neighbours never match. */
export function applyBandRhythm(sections: FunnelSection[]): FunnelSection[] {
  let flip = 0;
  return sections.map((s) => {
    const fixed = FIXED_BACKGROUND[s.type];
    if (fixed) return { ...s, background: fixed };
    const bg = ALTERNATING[flip % ALTERNATING.length];
    flip += 1;
    return { ...s, background: bg };
  });
}

export function sectionMeta(type: FunnelSectionType): SectionMeta {
  return SECTION_META.find((s) => s.type === type) ?? SECTION_META[0];
}

export function emptySection(
  type: FunnelSectionType,
  id: string,
): FunnelSection {
  const base: FunnelSection = {
    id,
    type,
    heading: "",
    subheading: "",
    body: "",
    items: [],
    mediaUrl: null,
    ctaLabel: "",
    deadline: null,
  };
  const meta = sectionMeta(type);
  if (meta.uses.items) {
    base.items = [{ title: "", body: "", meta: "" }];
  }
  if (meta.uses.cta) base.ctaLabel = "Get started";
  base.background = FIXED_BACKGROUND[type] ?? "default";
  // Long-form reads badly centred — a story is the one section that should
  // look like prose, not like a slide.
  base.alignLeft = type === "story";
  return base;
}

/**
 * Back-compat: funnels created before the section library have a flat
 * `landing` block. Synthesise equivalent sections on read so existing live
 * funnels keep rendering identically instead of going blank.
 */
export function sectionsFromLegacyLanding(
  landing: FunnelLanding | undefined,
): FunnelSection[] {
  if (!landing) return [];
  const out: FunnelSection[] = [
    {
      id: "legacy-hero",
      type: "hero",
      heading: landing.headline ?? "",
      subheading: landing.subheadline ?? "",
      body: "",
      items: [],
      mediaUrl: landing.videoUrl ? null : (landing.imageUrl ?? null),
      ctaLabel: "",
      deadline: null,
    },
  ];
  if (landing.videoUrl) {
    out.push({
      id: "legacy-video",
      type: "video",
      heading: "",
      subheading: "",
      body: "",
      items: [],
      mediaUrl: landing.videoUrl,
      ctaLabel: "",
      deadline: null,
    });
  }
  if (landing.bullets?.length) {
    out.push({
      id: "legacy-benefits",
      type: "benefits",
      heading: "",
      subheading: "",
      body: "",
      items: landing.bullets.map((b) => ({ title: b, body: "", meta: "" })),
      mediaUrl: null,
      ctaLabel: "",
      deadline: null,
    });
  }
  out.push({
    id: "legacy-cta",
    type: "cta",
    heading: "",
    subheading: "",
    body: "",
    items: [],
    mediaUrl: null,
    ctaLabel: landing.ctaLabel || "Get started",
    deadline: null,
  });
  return out;
}

/** A starter page per template — what "New funnel" drops in. */
export function templateSections(
  template: "simple_offer" | "vsl" | "lead_magnet",
): FunnelSectionType[] {
  if (template === "vsl") {
    return [
      "hero",
      "video",
      "benefits",
      "story",
      "pullquote",
      "steps",
      "testimonials",
      "offer",
      "faq",
      "guarantee",
      "cta",
    ];
  }
  if (template === "lead_magnet") {
    return ["hero", "benefits", "story", "steps", "bio", "faq", "cta"];
  }
  return [
    "hero",
    "logos",
    "benefits",
    "story",
    // Photo band with one overlay line — breaks the text run right after the
    // long-form story, which is where readers otherwise start skimming.
    "image",
    "comparison",
    "features",
    "steps",
    "pullquote",
    "stats",
    "testimonials",
    "offer",
    "faq",
    "guarantee",
    "cta",
  ];
}

/**
 * Repair the classic AI mis-fill of a comparison section.
 *
 * The contract is ONE item per contrast row: `title` = the full "life
 * without" sentence, `body` = the matching "life with" sentence (the renderer
 * prints all titles in the Without column and all bodies in the With column).
 * Models sometimes emit label/description PAIRS instead — {title: "Without
 * structure", body: "<without sentence>"} followed by {title: "With Acme",
 * body: "<with sentence>"} — which renders as nonsense: bare labels down one
 * column and every sentence (including the negatives) ticked in the other.
 *
 * That broken shape is unmistakable: an even run of items whose titles
 * alternate short "Without …" / "With …" labels. Merge each pair into one
 * proper row; anything else passes through untouched. (`/^with\b/` cannot
 * match "Without…" — no word boundary after "with" there — so the alternation
 * test is exact.)
 */
export function repairComparisonItems(
  items: FunnelSection["items"],
): FunnelSection["items"] {
  if (items.length < 2 || items.length % 2 !== 0) return items;
  const isLabel = (s: string, re: RegExp) => {
    const t = s.trim();
    return t.length > 0 && t.length <= 60 && re.test(t);
  };
  const looksBroken = items.every((it, i) =>
    i % 2 === 0
      ? isLabel(it.title, /^without\b/i)
      : isLabel(it.title, /^with\b/i),
  );
  if (!looksBroken) return items;

  const repaired: FunnelSection["items"] = [];
  for (let i = 0; i < items.length; i += 2) {
    repaired.push({
      title: items[i].body.trim() || items[i].title,
      body: items[i + 1].body.trim() || items[i + 1].title,
      meta: "",
    });
  }
  return repaired;
}
