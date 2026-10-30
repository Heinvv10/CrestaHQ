/**
 * Public-page competitor comparison data shape. Each /leadstack-vs-{slug}
 * page is rendered from one of these objects so the route, components,
 * and JSON-LD schema all consume a single typed source.
 *
 * Add a new competitor by:
 *   1. Creating src/data/comparisons/{slug}.ts that exports a Comparison.
 *   2. Adding it to src/data/comparisons/index.ts.
 *   3. Adding a footer link in src/components/landing/footer.tsx.
 * The route + sitemap pick it up automatically via generateStaticParams.
 */
/**
 * Structured cost model behind the interactive scenario calculator on a
 * comparison page. Every dollar figure MUST be consistent with the same
 * page's prose `pricing` notes — the calculator is the interactive twin
 * of those verified claims, never a separate source of numbers.
 *
 * The layout is slot-based so the two cost cards stay row-aligned:
 * base line (always) + optional per-unit addon slider + optional flat
 * monthly toggle + optional one-time fee. Omit `calculator` entirely to
 * hide the section on that competitor's page.
 */
export type ComparisonCalculatorConfig = {
  /** Section heading, e.g. "Build your scenario — …". */
  heading: string;
  /** One-paragraph intro under the heading. */
  intro: string;
  /** Title on the competitor cost card (short name reads best). */
  competitorTitle: string;
  /**
   * Primary "how many clients" slider. Omit when the competitor's cost
   * model has no per-client axis (e.g. a flat agency subscription) —
   * per-"unit" lines then multiply by 1.
   */
  unit?: {
    sliderLabel: string;
    min: number;
    max: number;
    defaultValue: number;
  };
  /** The competitor's platform subscription — always present. */
  base: {
    label: string;
    monthly: number;
    /** "unit" multiplies by the unit slider; "flat" charges once. */
    per: "flat" | "unit";
    hint?: string;
    /** Hint under the LeadStack "License (one-time)" counterpart row. */
    leadstackHint?: string;
  };
  /** Optional secondary slider for a per-seat / per-portal monthly addon. */
  addon?: {
    sliderLabel: string;
    /** Cost-card line label (kept short; count is appended). */
    lineLabel: string;
    monthlyPerUnit: number;
    defaultValue: number;
    /** Cap the slider at the unit slider's current value (GHL-style
     *  "AI per sub-account"). When false/absent, `max` applies. */
    clampToUnit?: boolean;
    /** Slider max when not clamped to the unit count. */
    max?: number;
    hint?: string;
    leadstack: { label: string; hint?: string };
  };
  /** Optional flat monthly add-on toggle (e.g. premium support). */
  toggle?: {
    label: string;
    description: string;
    monthly: number;
    defaultOn: boolean;
    hint?: string;
    leadstack: { label: string; hint?: string };
  };
  /** Optional one-time fee (e.g. mandatory onboarding). */
  oneTime?: {
    label: string;
    amount: number;
    per: "flat" | "unit";
    hint?: string;
    leadstack: { label: string; hint?: string };
  };
  /** Sentence after the payback line, e.g. "in typical agency use …". */
  paybackNote: string;
};

export type Comparison = {
  /** URL slug — becomes /leadstack-vs-{slug}. Lowercase, hyphenated. */
  slug: string;
  /** Display name of the competitor (e.g. "GoHighLevel", "HubSpot"). */
  competitorName: string;
  /** Optional short-form name for tight contexts (table headers, etc.). */
  competitorShortName?: string;
  /** Per-page meta title — Google's SERP headline. <=60 chars ideal. */
  metaTitle: string;
  /** Per-page meta description. ~155 chars ideal. */
  metaDescription: string;
  /** Last factually verified — surfaces in the legal disclaimer. */
  lastVerifiedDate: string;
  /** Hero block. */
  hero: {
    h1: string;
    subhead: string;
    ctaLabel: string;
  };
  /** Pull-quote framed as a customer/operator switching from competitor. */
  pullQuote: {
    text: string;
    author: string;
    role?: string;
  };
  /** 3-bullet "the problem with X" framing block. */
  painPoints: {
    heading: string;
    bullets: Array<{
      title: string;
      body: string;
    }>;
  };
  /** 4-block advantage grid — what LeadStack does differently. */
  advantages: Array<{
    title: string;
    body: string;
  }>;
  /** Feature-by-feature comparison table. */
  featureTable: {
    heading: string;
    rows: Array<{
      label: string;
      /** Optional group heading. When a row's category differs from the
       *  previous row's, the table renders a section divider above it.
       *  Leave unset on every row for a flat, ungrouped table. */
      category?: string;
      /** Optional clarifying footnote. When set, the label gets a
       *  superscript marker and the text is listed beneath the table.
       *  Markers are numbered in row order. */
      footnote?: string;
      /** true = check, false = X, string = note (e.g. "Add-on $X/mo"). */
      leadstack: boolean | string;
      competitor: boolean | string;
    }>;
  };
  /** Pricing comparison block — the part GHL skips. */
  pricing: {
    heading: string;
    leadstack: {
      headline: string;
      detail: string;
      notes: string[];
    };
    competitor: {
      headline: string;
      detail: string;
      notes: string[];
    };
    summary: string;
  };
  /** Honest "where the competitor wins" section. Builds trust. Optional —
   *  omit to hide the section entirely. */
  competitorWins?: {
    heading: string;
    bullets: string[];
    closing: string;
  };
  /** FAQ section — fuel for FAQPage JSON-LD schema. */
  faq: {
    heading: string;
    items: Array<{
      question: string;
      answer: string;
    }>;
  };
  /** Interactive scenario calculator — omit to hide the section. */
  calculator?: ComparisonCalculatorConfig;
  /** Final CTA copy. */
  finalCta: {
    headline: string;
    body: string;
    primaryCtaLabel: string;
    primaryCtaHref: string;
  };
};
