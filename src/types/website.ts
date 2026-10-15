import type { Timestamp, FieldValue } from "firebase/firestore";

/**
 * Mirrors the gitpage.site typeform inputs verbatim. Field names match
 * gitpage's source-of-truth so the payload we send maps 1:1 to what their
 * generator expects.
 *
 * Internal fields:
 *   - site_type: legacy. Kept on the doc as "LocalSite" for back-compat;
 *     `build_type` is the actual discriminator now.
 *   - astra_theme: server-managed, hard-coded false. Not exposed to the UI.
 *
 * build_type maps directly to gitpage's `buildType` parameter:
 *   - "local" → multi-page LocalSite (home + optional services/contact/terms)
 *   - "vsl"   → single-page Video Sales Letter funnel
 */

export type WebsiteStatus =
  | "draft"
  | "queued"
  | "building"
  | "ready"
  | "failed";

export type BuildType = "local" | "vsl";

export type ColorScheme = "Standard" | "Dark Mode";

/**
 * Niche templates ship a research-backed design system, section structure,
 * imagery, and copy tone for a specific vertical. Optional — omit for a
 * generic build. Both local and vsl support the same set of niche keys.
 *
 * When set on a `local` build, gitpage forces pages to
 *   [index, services, contact, privacy, terms]
 * and rejects blog pages.
 *
 * When set on a `vsl` build, gitpage auto-ships privacy + terms.
 */
export type Niche =
  | "home_services"
  | "real_estate"
  | "gym_fitness"
  | "agency_consulting"
  | "ai_consulting"
  | "ai_automation";

/**
 * Build quality (Website Build v2). `premium` is gitpage's staged,
 * design-system build — Opus-authored brief, Higgsfield images, the
 * sub-account's own LeadStack form + chat widget wired in, and a chat-bot KB
 * handed back on publish. `standard` is the original v1 generator. Absent on
 * legacy docs — readers treat absent as "premium" (`effectiveQuality`).
 */
export type WebsiteQuality = "standard" | "premium";

/** Premium hero treatment. Null = the concept's default. */
export type HeroMotion = "still" | "loop" | "atmosphere";

/**
 * Optional premium inputs — everything here is operator-supplied FACT the
 * brief writer may use verbatim; nothing is invented from it. Multi-value
 * fields are plain text (one entry per line, " | " between columns) so the
 * form is a handful of textareas; the gitpage client parses them into the
 * API's typed arrays at submit time.
 */
export interface WebsitePremiumDetails {
  /** ≤120 chars. */
  tagline: string;
  /** Four-digit year, or blank. */
  founded_year: string;
  /** Up to 5 comma-separated words, e.g. "direct, athletic, warm". */
  brand_voice: string;
  /** One per line: "Label: Value" (≤4). */
  metrics: string;
  /** One per line: "Name | Role | Credentials | What they do" (≤6). */
  team: string;
  /** One per line: "Quote | Name | Role" (≤6). */
  testimonials: string;
  /** ≤110 chars. */
  offer_headline: string;
  /** One per line (≤5). */
  offer_bullets: string;
  /** ≤160 chars. */
  offer_fine: string;
  /** ≤600 chars — art direction for the generated photography. */
  gallery_notes: string;
  /** One per line: "Label | https://…" (≤6). */
  social_links: string;
  /** ≤4000 chars — anything else the brief writer should know. */
  reference_notes: string;
  /** AI niches: comma-separated tools/platforms they build with (≤12). */
  tools?: string;
  /** AI niches: one per line "Client | Result | What we did" (≤4). */
  case_studies?: string;
}

export function blankPremiumDetails(): WebsitePremiumDetails {
  return {
    tagline: "",
    founded_year: "",
    brand_voice: "",
    metrics: "",
    team: "",
    testimonials: "",
    offer_headline: "",
    offer_bullets: "",
    offer_fine: "",
    gallery_notes: "",
    social_links: "",
    reference_notes: "",
    tools: "",
    case_studies: "",
  };
}

export interface WebsiteServicesConfig {
  let_ai_do_services: boolean;
  /** Only used when let_ai_do_services === false. */
  services_list: string;
}

export interface WebsiteBusinessDetails {
  business_name: string;
  business_street: string;
  business_city: string;
  business_state: string;
  business_country: string;
  business_zip: string;
  business_phone: string;
  business_email: string;
  google_rating: string;
  google_review_count: string;
  opening_hours: string;
}

export interface WebsitePageSelections {
  /** Always true; index.html is required by gitpage. UI locks this on. */
  index: true;
  services: boolean;
  contact: boolean;
  /** Newly allowed by gitpage v1; required when niche is set. */
  privacy: boolean;
  terms: boolean;
}

export interface WebsiteConfig {
  // Always required
  site_type: "LocalSite";
  /**
   * Discriminator between gitpage's two supported builders. Existing docs
   * predating VSL won't carry this — readers default to "local".
   */
  build_type: BuildType;
  /**
   * Optional niche template key. When set, gitpage swaps in a research-backed
   * design system + section structure + copy tone for that vertical. Both
   * local and vsl support niche; omit (null) for a generic build. Existing
   * docs predating the niche feature won't carry this — readers default to
   * null.
   */
  niche: Niche | null;
  language: string;
  /** Max 80 chars enforced client-side; server re-validates. */
  heading: string;
  color_scheme: ColorScheme;
  hero_statement: string;
  features: string;
  benefits: string;
  /** Email address. */
  contact_details: string;
  /** http(s) URL. */
  cta_link: string;
  include_faq: boolean;

  /** Required when build_type === "vsl"; ignored otherwise. http(s) URL. */
  video_link: string;

  local_page_selections: WebsitePageSelections;

  /** Populated only when build_type === "local" + services.html selected. */
  services_config: WebsiteServicesConfig | null;
  /** Populated only when build_type === "local" + contact.html selected. */
  business_details: WebsiteBusinessDetails | null;

  // Design — picked from gitpage's canonical value lists. Validation rejects
  // anything not in those lists. See lib/website/gitpage-values.ts.
  design_color_palette: string;
  /** Required when design_color_palette === "Custom" — hex triple, e.g. "#5B4BFF,#EEF0FF,#00E5A8". */
  custom_colors: string;
  design_typography: string;
  design_layout: string;
  design_components: string;
  design_interactions: string;
  design_buttons: string;
  design_contact_form: string;
  design_icons: string;

  /** System flag — hard-coded false in v1. Hidden from UI. */
  astra_theme: false;

  // --- Website Build v2 (premium) — all optional so pre-v2 docs read clean.

  /** Absent = "premium" (the default since Build v2). */
  quality?: WebsiteQuality;
  /**
   * Premium concept id from gitpage's `GET /api/v1/concepts` (three
   * studio-style options per niche). Null = gitpage picks the niche default.
   */
  concept?: string | null;
  hero_motion?: HeroMotion | null;
  /**
   * Wire the sub-account's own LeadStack contact form into the site's
   * contact section (premium only). Absent = true.
   */
  include_form?: boolean;
  /**
   * Drop the sub-account's AI web-chat widget on every page (premium only).
   * Absent = true.
   */
  include_chat?: boolean;
  /**
   * Turn on the Web Voice mic (talk to the chat widget) when the site
   * publishes. Only acts when the workspace has a ready ElevenLabs
   * connection; never switches voice OFF (it's workspace-wide, shared by
   * every site). Needs include_chat. Absent = true.
   */
  include_voice?: boolean;
  premium_details?: WebsitePremiumDetails | null;

  // --- Agency templates (lib/website/templates.ts) — optional, absent on every other site.

  /**
   * gitpage template id: build this site from one of the agency's saved
   * templates (gitpage copies its design and pages, then swaps in
   * business_details and the LeadStack wiring). build_type stays "local".
   */
  template_id?: string | null;
  /** The template's name, for display. */
  template_name?: string | null;
}

/** Absent/unknown quality reads as premium — the Build v2 default. */
export function effectiveQuality(
  config: Pick<WebsiteConfig, "quality"> | null | undefined,
): WebsiteQuality {
  return config?.quality === "standard" ? "standard" : "premium";
}

export function wantsLeadForm(config: Pick<WebsiteConfig, "include_form" | "quality">): boolean {
  return effectiveQuality(config) === "premium" && config.include_form !== false;
}

export function wantsChatWidget(config: Pick<WebsiteConfig, "include_chat" | "quality">): boolean {
  return effectiveQuality(config) === "premium" && config.include_chat !== false;
}

export function wantsWebVoice(
  config: Pick<WebsiteConfig, "include_chat" | "include_voice" | "quality">,
): boolean {
  return wantsChatWidget(config) && config.include_voice !== false;
}

/**
 * What LeadStack auto-provisioned when a premium build published — written
 * once per publish by `provisionWebsiteHandoff` so the site card (and the
 * assistant's status check) can say exactly what is wired.
 */
export interface WebsiteProvisioning {
  at: Timestamp | FieldValue | null;
  /** The live site's hostname (added to the web-chat allowlist). */
  hostname: string | null;
  formId: string | null;
  chatAllowlisted: boolean;
  chatEnabled: boolean;
  /** Why the chat channel was NOT switched on (null when it was). */
  chatSkippedReason: string | null;
  /** Web Voice mic is on for this workspace after the hand-off. Absent on
   *  builds from before Web Voice existed. */
  voiceEnabled?: boolean;
  /** Why a requested Web Voice enable was skipped. Absent on older builds. */
  voiceSkippedReason?: string | null;
  kbSeeded: boolean;
  personaSeeded: boolean;
  workflowId: string | null;
  workflowStatus: "active" | "draft" | null;
  /** Channel steps kept in the speed-to-lead workflow (sms/email/notify). */
  workflowChannels: string[];
  /** Best-effort steps that failed — never block the publish. */
  errors: string[];
}

/**
 * Subcollection doc at `subAccounts/{subAccountId}/website/{siteId}`. A
 * sub-account can hold up to `MAX_WEBSITES_PER_SUBACCOUNT` of these (see
 * `lib/website/limits.ts`). The legacy singleton lives at `.../website/main`
 * and remains valid as one of the slots — no migration needed.
 */
export interface WebsiteDoc {
  id: string;
  agencyId: string;
  subAccountId: string;
  /**
   * Operator-facing label for the site card. Defaulted to `Website N` at
   * creation. Legacy `main` docs predate this field — readers fall back to
   * the config heading, then "Untitled site".
   */
  name?: string;
  status: WebsiteStatus;
  /** Provider job id — null until a build is submitted. */
  gitpageJobId: string | null;
  /** Live URL once status === "ready". */
  liveUrl: string | null;
  /** Populated when status === "failed". */
  errorMessage: string | null;
  /**
   * Per-page generation warnings from gitpage on a successful build (e.g.
   * blog page failed but home + services succeeded). Shown alongside the
   * live URL. Null when there were none or the build hasn't finished.
   */
  partialErrors: string[] | null;
  /** Number of times we've polled gitpage for the current job — used to cap. */
  pollAttempts: number;
  lastBuildAt: Timestamp | FieldValue | null;
  lastBuildByUid: string | null;
  config: WebsiteConfig;
  createdAt: Timestamp | FieldValue | null;
  updatedAt: Timestamp | FieldValue | null;

  // --- Website Build v2 (premium) — optional, stamped by the build path.

  /** Quality the CURRENT job was submitted at (mirrors config.quality). */
  quality?: WebsiteQuality | null;
  /**
   * The "Website contact" LeadStack form wired into the site. Created on
   * first premium build and reused on rebuilds; null for standard builds.
   */
  formId?: string | null;
  /** gitpage's estimate for the current job — drives the poll cap + copy. */
  estimatedDurationSeconds?: number | null;
  /** gitpage's current stage name while building (brief / images / …). */
  statusPhase?: string | null;
  /** Human concept name gitpage reported for the published build. */
  conceptName?: string | null;
  /** Hand-off summary — null until the first premium publish. */
  provisioning?: WebsiteProvisioning | null;
  /** Last wizard step the operator saved on — the modal resumes here. */
  wizardStep?: string | null;
  /** gitpage page record id (the GitPage MCP `pageId`) — set on publish. */
  gitpagePageId?: string | null;
  /** Email gitpage invited as an editor for the current build (the builder). */
  editorEmail?: string | null;
  /**
   * The terminal report `settleWebsiteBuild` last applied: which job, and
   * whether gitpage said Published or failed. A repeat of the same report
   * for the same job is ignored (a replayed callback cannot re-settle).
   */
  settledDelivery?: { jobId: string; status: "Published" | "failed" } | null;
  /**
   * Custom domain the operator serves this site on (set in GitLab/GitHub),
   * e.g. "www.peakyoga.com". Allow-listed for Web Chat; preferred over
   * liveUrl wherever LeadStack shows or reads the site.
   */
  customDomain?: string | null;
  /**
   * The Web Chat allow-list hosts the custom-domain save added (the domain's
   * www/apex pair, minus any already listed). Removing the domain takes off
   * these and nothing else, so hosts the operator listed by hand stay.
   */
  customDomainChatHosts?: string[] | null;
  /** Latest Google PageSpeed Insights (mobile) scores — set ~2 min after publish. */
  pagespeed?: WebsitePageSpeed | null;
  /**
   * "gitpage": a copy the client made in gitpage (Duplicate), imported by the
   * Websites page sync (lib/server/website-import-service.ts). No LeadStack
   * build behind it.
   */
  importedFrom?: "gitpage" | null;
  /**
   * The gitpage site the current build replaces (a rebuild makes a new gitpage
   * site). Once the new one publishes, the old one is hidden in gitpage (it
   * stays live), so gitpage lists the same sites as LeadStack. Kept across a
   * failed build until one publishes.
   */
  replacesGitpagePageId?: string | null;
}

export interface WebsitePageSpeed {
  url: string;
  strategy: "mobile";
  /** 0–100, null when the category didn't run. */
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  error: string | null;
  at: Timestamp | FieldValue | null;
}

/** The address visitors use: the custom domain when set, else the gitpage URL. */
export function siteAddress(doc: Pick<WebsiteDoc, "customDomain" | "liveUrl">): string | null {
  return doc.customDomain ? `https://${doc.customDomain}/` : doc.liveUrl ?? null;
}

/**
 * Empty starter values used when the UI mounts on a sub-account that has
 * never built a site. Mirrors the WebsiteConfig shape so the form has
 * something to render against and the user only fills in non-blank fields.
 */
export function blankWebsiteConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: null,
    language: "English",
    heading: "",
    color_scheme: "Standard",
    hero_statement: "",
    features: "",
    benefits: "",
    contact_details: "",
    cta_link: "",
    include_faq: false,
    video_link: "",
    local_page_selections: {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    },
    services_config: null,
    business_details: null,
    // Defaults match gitpage's documented defaults so an untouched form
    // produces a reasonable site.
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    include_voice: true,
    premium_details: null,
  };
}

export function blankServicesConfig(): WebsiteServicesConfig {
  return { let_ai_do_services: true, services_list: "" };
}

export function blankBusinessDetails(): WebsiteBusinessDetails {
  return {
    business_name: "",
    business_street: "",
    business_city: "",
    business_state: "",
    business_country: "",
    business_zip: "",
    business_phone: "",
    business_email: "",
    google_rating: "",
    google_review_count: "",
    opening_hours: "",
  };
}

/**
 * Demo prefill — Starbucks Chadstone. Wired to the "Sample" button on the
 * form so a complete payload can be submitted in one click during demos.
 */
export function sampleWebsiteConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: null,
    language: "English",
    heading: "Starbucks Coffee Chadstone",
    color_scheme: "Standard",
    hero_statement: "Best Coffee In Melbourne",
    features: "Premium Espresso, Cozy Ambiance, Local Favorite",
    benefits: "Exceptional Taste, Welcoming Vibe, Local Pride",
    contact_details: "admin@sbc.com",
    cta_link: "https://sbc.com",
    include_faq: true,
    video_link: "",
    local_page_selections: {
      index: true,
      services: true,
      contact: true,
      privacy: false,
      terms: true,
    },
    services_config: {
      let_ai_do_services: false,
      services_list:
        "Welcoming coffeehouse with handcrafted coffee, espresso & tea, plus breakfast, lunch & pastries.",
    },
    business_details: {
      business_name: "Starbucks Chadstone",
      business_street: "1341 Dandenong Road",
      business_city: "Chadstone",
      business_state: "Victoria",
      business_country: "Australia",
      business_zip: "3148",
      business_phone: "",
      business_email: "admin@sbc.com",
      google_rating: "3.8",
      google_review_count: "1393",
      opening_hours:
        "Monday: 6:00 AM – 9:00 PM\nTuesday: 6:00 AM – 9:00 PM\nWednesday: 6:00 AM – 9:00 PM\nThursday: 6:00 AM – 9:00 PM\nFriday: 6:00 AM – 9:00 PM\nSaturday: 7:00 AM – 9:00 PM\nSunday: 7:00 AM – 9:00 PM",
    },
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: null,
  };
}

/**
 * Blank starter for the VSL (Video Sales Letter) builder. Single-page funnel —
 * no pages array, no business / services blocks. video_link is required at
 * submit time.
 */
export function blankVslConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "vsl",
    niche: null,
    language: "English",
    heading: "",
    color_scheme: "Standard",
    hero_statement: "",
    features: "",
    benefits: "",
    contact_details: "",
    cta_link: "",
    include_faq: false,
    video_link: "",
    local_page_selections: {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    },
    services_config: null,
    business_details: null,
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: null,
  };
}

/**
 * Demo prefill for the VSL builder. Coaching/consulting offer matching the
 * canonical VSL audience (coaches, consultants, course creators). YouTube
 * embed is a public clip so demos work anywhere without auth issues.
 */
export function sampleVslConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "vsl",
    niche: null,
    language: "English",
    heading: "Scale Your Coaching Practice To $30k/Month",
    color_scheme: "Standard",
    hero_statement: "Without burning out, hiring a team, or paid ads.",
    features: "Lead System, Sales Script, Delivery Playbook",
    benefits: "Predictable Income, Premium Clients, Time Freedom",
    contact_details: "hello@scalecoach.com",
    cta_link: "https://cal.com/scalecoach/strategy-call",
    include_faq: true,
    video_link: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    local_page_selections: {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    },
    services_config: null,
    business_details: null,
    design_color_palette: "Bold / Creative",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: null,
  };
}

// ---------------------------------------------------------------------------
// Niche sample prefills — one per (niche × build type) combination, six total.
// Mirror the example payloads in §2.5–2.7 and §3.4–3.6 of
// LEADSTACK_NICHE_TEMPLATES.md. Niche-locked page sets force services + contact
// + privacy + terms all true; business_details are required since contact is
// forced on. Design fields are still set on niche samples but gitpage's niche
// directive overrides them — they're left in place so the form renders cleanly
// if a user later flips niche back to null.

export function sampleHomeServicesLocalConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: "home_services",
    language: "English",
    heading: "Acme Plumbing — Charlotte's Trusted Plumbers Since 1998",
    color_scheme: "Standard",
    hero_statement:
      "Licensed, insured, on-time guaranteed. Same-day service across Charlotte.",
    features: "Emergency Repair, Water Heater Install, Drain Cleaning",
    benefits:
      "24/7 live phone, Flat-rate pricing, Satisfaction guarantee",
    contact_details: "office@acmeplumbing.example",
    cta_link: "https://acmeplumbing.example/book",
    include_faq: true,
    video_link: "",
    local_page_selections: {
      index: true,
      services: true,
      contact: true,
      privacy: true,
      terms: true,
    },
    services_config: { let_ai_do_services: true, services_list: "" },
    business_details: {
      business_name: "Acme Plumbing",
      business_street: "201 W Trade St",
      business_city: "Charlotte",
      business_state: "NC",
      business_country: "USA",
      business_zip: "28202",
      business_phone: "(704) 555-0142",
      business_email: "office@acmeplumbing.example",
      google_rating: "4.9",
      google_review_count: "1247",
      opening_hours: "24/7 Emergency Service",
    },
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Same-day plumbing and heating, done properly.",
      founded_year: "1998",
      brand_voice: "plain-spoken, reassuring, competent",
      metrics: "Years in Charlotte: 27\nJobs completed: 40,000+\nGoogle rating: 4.9\nResponse time: < 60 min",
      team: "Dana Whitfield | Owner · Master Plumber | NC Plumbing License · 27 years | Runs dispatch and the hard jobs herself.\nLuis Ortega | Lead Heating Technician | NATE Certified · Gas fitter | Furnace diagnostics and replacements.\nSam Okafor | Service Plumber | Journeyman · Backflow certified | Water heaters and drain systems.",
      testimonials: "Burst pipe at 11 pm on a Sunday. Sam was here in 40 minutes, had it capped in ten, and came back Monday to do the permanent fix. Price was exactly the quote. | Rachel Nguyen | Homeowner, Dilworth\nThey replaced our 30-year-old furnace in a day and the house has never been this even. The crew wore boot covers and vacuumed on the way out. | Tom Becker | Homeowner, NoDa\nWe use Acme for all twelve of our rental units. Clear invoices, photos of the work, no surprises. | Heidi Larsen | Property Manager",
      offer_headline: "Emergency? We're 60 minutes away.",
      offer_bullets: "24/7 live dispatch, no answering service\nUpfront, written price before any work starts\nOne-year workmanship warranty on every repair",
      offer_fine: "Emergency call-out fee waived when we do the repair.",
      gallery_notes: "Real-feeling trade photography: a tech in a clean navy uniform at a water heater; a service van at dusk in a Charlotte driveway; a tidy furnace install; hands with a pipe wrench; before/after of a bathroom rough-in.",
      social_links: "Facebook | https://facebook.com/acmeplumbing",
      reference_notes: "",
    },
  };
}

export function sampleHomeServicesVslConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "vsl",
    niche: "home_services",
    language: "English",
    heading: "Hey Charlotte — Tired of Cold Showers?",
    color_scheme: "Standard",
    hero_statement:
      "Same-day water heater repair and install with upfront pricing.",
    features:
      "Free 2nd opinion, $200 off heaters, 0% APR 12 months",
    benefits: "Licensed and insured, On-time guarantee, 4.9-star rated",
    contact_details: "office@acmeplumbing.example",
    cta_link: "https://acmeplumbing.example/book",
    include_faq: true,
    video_link: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    local_page_selections: {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    },
    services_config: null,
    business_details: null,
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Same-day plumbing and heating, done properly.",
      founded_year: "",
      brand_voice: "plain-spoken, reassuring, competent",
      metrics: "Response: < 60 min\nRating: 4.9\nSince: 1998",
      team: "",
      testimonials: "",
      offer_headline: "Book a same-day visit.",
      offer_bullets: "Written price before work starts\nOne-year warranty\nCall-out fee waived with repair",
      offer_fine: "",
      gallery_notes: "Hero still: an Acme van at dusk outside a Charlotte craftsman home.",
      social_links: "",
      reference_notes: "",
    },
  };
}

export function sampleRealEstateLocalConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: "real_estate",
    language: "English",
    heading: "Serena Stone",
    color_scheme: "Standard",
    hero_statement:
      "Upper East Side real estate with discretion and a proven record.",
    features:
      "Buyer Representation, Seller Representation, Off-Market",
    benefits: "Top 1% Producer, $1.2B career sales, 99% sale-to-list",
    contact_details: "serena@stonere.example",
    cta_link: "https://stonere.example/connect",
    include_faq: true,
    video_link: "",
    local_page_selections: {
      index: true,
      services: true,
      contact: true,
      privacy: true,
      terms: true,
    },
    services_config: { let_ai_do_services: true, services_list: "" },
    business_details: {
      business_name: "Stone Real Estate",
      business_street: "1230 Madison Avenue",
      business_city: "New York",
      business_state: "NY",
      business_country: "USA",
      business_zip: "10128",
      business_phone: "(212) 555-0188",
      business_email: "serena@stonere.example",
      google_rating: "",
      google_review_count: "",
      opening_hours: "By appointment",
    },
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Considered advice for the homes that matter most.",
      founded_year: "2011",
      brand_voice: "discreet, assured, editorial",
      metrics: "Career sales: $1.2B\nSale-to-list: 99%\nAvg. days on market: 11\nRepeat & referral: 82%",
      team: "Serena Stone | Founder · Principal Broker | Licensed NY Broker · CRS · Luxury Home Marketing Specialist | Leads every listing personally; 14 years on the Upper East Side.\nEvelyn Tsai | Buyer's Advisor | Licensed Agent · ABR | Off-market sourcing and negotiation for buyers.",
      testimonials: "Serena told us the number, told us why, and got it in nine days with two backup offers. No theatre, just a plan. | The Whitmores | Sellers, Carnegie Hill\nWe saw four homes that never hit the market. The one we bought was the second. | Jonathan & Ari Feld | Buyers, Lenox Hill\nHer valuation for our parents' estate was thorough enough that the attorneys used it directly. | Caroline Boyd | Executor",
      offer_headline: "Start with a private consultation.",
      offer_bullets: "A written pricing opinion within 48 hours\nA candid read on timing and preparation\nNo obligation, no listing pressure",
      offer_fine: "Consultations are held at the Madison Avenue office or at your home.",
      gallery_notes: "Editorial architecture and interiors: a limestone townhouse façade in soft morning light; a marble kitchen island; a tree-lined street in autumn; a considered portrait of the broker in a tailored coat; closing documents and a fountain pen.",
      social_links: "Instagram | https://instagram.com/stonerealestate\nLinkedIn | https://linkedin.com/in/serenastone",
      reference_notes: "",
    },
  };
}

export function sampleRealEstateVslConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "vsl",
    niche: "real_estate",
    language: "English",
    heading: "What Is Your UES Home Worth — Today?",
    color_scheme: "Dark Mode",
    hero_statement: "A complimentary, comp-driven valuation in 24 hours.",
    features: "Off-market access, $1.2B career sales, 99% sale-to-list",
    benefits: "Discreet, Considered, Evidence-led",
    contact_details: "serena@stonere.example",
    cta_link: "https://stonere.example/valuation",
    include_faq: true,
    video_link: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    local_page_selections: {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    },
    services_config: null,
    business_details: null,
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Considered advice for the homes that matter most.",
      founded_year: "",
      brand_voice: "discreet, assured, editorial",
      metrics: "Career sales: $1.2B\nSale-to-list: 99%\nDays on market: 11",
      team: "",
      testimonials: "",
      offer_headline: "Request a written valuation.",
      offer_bullets: "Delivered within 48 hours\nComparable sales explained\nNo obligation",
      offer_fine: "",
      gallery_notes: "Hero still: a townhouse doorway at blue hour, warm light inside.",
      social_links: "",
      reference_notes: "",
    },
  };
}

export function sampleGymFitnessLocalConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: "gym_fitness",
    language: "English",
    heading: "PEAK — Train Harder. Live Stronger.",
    color_scheme: "Dark Mode",
    hero_statement:
      "Coach-led sessions, small-group programming, in the heart of New York.",
    features: "HR tracking, Small-group coaching, Programmed cycles",
    benefits: "Adapt fast, Stay durable, Train sharper",
    contact_details: "admin@peak.com",
    cta_link: "https://peak.com",
    include_faq: true,
    video_link: "",
    local_page_selections: {
      index: true,
      services: true,
      contact: true,
      privacy: true,
      terms: true,
    },
    services_config: { let_ai_do_services: true, services_list: "" },
    business_details: {
      business_name: "PEAK",
      business_street: "4 Astor Place",
      business_city: "New York",
      business_state: "NY",
      business_country: "USA",
      business_zip: "10003",
      business_phone: "(917) 877-1400",
      business_email: "admin@peak.com",
      google_rating: "4.5",
      google_review_count: "966",
      opening_hours: "Mon-Thu 5:30am-10pm, Fri 5:30am-8pm, Sat-Sun 8am-8pm",
    },
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Rituals that elevate your training.",
      founded_year: "",
      brand_voice: "direct, athletic, warm",
      metrics: "Min / Session: 45\nClasses / Month: 900+\nMember : Coach: 3:1\nWks To Reset: 12",
      team: "Mia Carter | Head Coach | CSCS · USAW Level 2 · Precision Nutrition L1 | Barbell strength and return-to-performance programming.\nJordan Lee | Performance Coach | NSCA-CPT · FRCms · EXOS Performance Specialist | Designs PEAK Engine intervals; sprint mechanics and conditioning.\nAlex Rivera | Mobility & Reset | RYT-500 · FMS Level 2 · STOTT Pilates | Anchors PEAK Reset; breath, mobility and recovery.",
      testimonials: "In 10 weeks my resting heart rate dropped 9 bpm and I feel more focused at work. The coaches remembering my goals made it simple to show up three times a week. | Danielle Kim | Product Designer\nOver six months I added 85 pounds to my deadlift and feel more durable on long runs. The Lift blocks finally gave me a plan I could commit to. | Marcus Alvarez | Corporate Attorney\nAfter having my daughter I needed a space that respected where my body was but still challenged me. I am stronger now than before pregnancy. | Priya Desai | Founder · New Parent",
      offer_headline: "Start with your free week on us.",
      offer_bullets: "First class free with guided check-in and baseline assessment\nOptional 7-day unlimited trial across Lift, Engine, Ride and Reset\nMoney-back guarantee if you don't feel the difference after your first week",
      offer_fine: "Limited spots per class to keep coaching tight. Reserve in under 60 seconds.",
      gallery_notes: "Moody boutique gym interiors: black steel, polished concrete, one yellow accent wall; a single athlete mid-effort under dramatic side light; treadmills under neon; a calm recovery room with hardwood and natural light.",
      social_links: "Instagram | https://instagram.com/peakastorplace",
      reference_notes: "",
    },
  };
}

export function sampleGymFitnessVslConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "vsl",
    niche: "gym_fitness",
    language: "English",
    heading: "How NYC Professionals Train Like Athletes Without Quitting Their Day Jobs.",
    color_scheme: "Dark Mode",
    hero_statement:
      "Coach-led sessions and smart programming, sharper every week.",
    features: "Coach-led, HR tracked, Progressive",
    benefits: "Adapt fast, Stay durable, Train sharper",
    contact_details: "admin@peak.com",
    cta_link: "https://peak.com",
    include_faq: true,
    video_link: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    local_page_selections: {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    },
    services_config: null,
    business_details: null,
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Rituals that elevate your training.",
      founded_year: "",
      brand_voice: "direct, athletic, warm",
      metrics: "Members: 2,300+\nCoaches: Certified\nRating: 4.5/5",
      team: "",
      testimonials: "",
      offer_headline: "Claim your free week.",
      offer_bullets: "First class free\n7-day unlimited trial\nNo contract",
      offer_fine: "Reserve in under 60 seconds.",
      gallery_notes: "One hero still of the studio floor at golden hour, empty, lights on.",
      social_links: "",
      reference_notes: "",
    },
  };
}

export function sampleAgencyConsultingLocalConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: "agency_consulting",
    language: "English",
    heading: "Vantage Studio",
    color_scheme: "Standard",
    hero_statement: "Brands built to be unignorable.",
    features: "Brand strategy, Identity systems, Websites that convert",
    benefits: "Clarity first, Craft always, Results you can measure",
    contact_details: "hello@vantage.studio",
    cta_link: "https://vantage.studio/start",
    include_faq: true,
    video_link: "",
    local_page_selections: {
      index: true,
      services: true,
      contact: true,
      privacy: true,
      terms: true,
    },
    services_config: {
      let_ai_do_services: false,
      services_list:
        "Brand strategy — positioning, naming and messaging built on research; Identity — logo systems, typography, colour and guidelines; Websites — design and build on modern stacks, measured on conversion; Campaigns — launch creative across paid, social and email",
    },
    business_details: {
      business_name: "Vantage Studio",
      business_street: "31 Flinders Lane",
      business_city: "Melbourne",
      business_state: "VIC",
      business_country: "Australia",
      business_zip: "3000",
      business_phone: "+61 3 9000 1234",
      business_email: "hello@vantage.studio",
      google_rating: "5.0",
      google_review_count: "41",
      opening_hours: "Mon–Fri 9:00 AM – 5:30 PM",
    },
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Brands built to be unignorable.",
      founded_year: "2016",
      brand_voice: "sharp, confident, generous",
      metrics: "Brands launched: 140+\nAvg. conversion lift: 38%\nYears: 9\nTeam: 12",
      team: "Ines Moreau | Founder · Creative Director | Ex-Pentagram London | Leads strategy and identity.\nKofi Mensah | Head of Digital | 12 years product design | Websites, systems and measurement.\nTessa Lindqvist | Strategy Director | MBA · former brand planner | Positioning, research and naming.",
      testimonials: "They renamed us, rebuilt the site, and our demo requests went up 38% in the first quarter. The work was the easy part; the thinking was the value. | Priya Raman | CEO, Loopwise\nVantage treats a brand like a product: hypotheses, tests, decisions. It's the first agency we've kept for three years. | Daniel Okoye | CMO, Harbourline",
      offer_headline: "Start with a 45-minute brand diagnostic.",
      offer_bullets: "We review your positioning, identity and site against your category\nYou get a written read-out with three priorities\nNo pitch deck, no obligation",
      offer_fine: "We take on six new brands a year.",
      gallery_notes: "Studio life shot editorially: a pinned wall of identity explorations; a designer's desk with a printed brand book; a large monitor with a finished website; a client review in a light-filled Melbourne studio; printed collateral flat lay.",
      social_links: "Instagram | https://instagram.com/vantage.studio\nLinkedIn | https://linkedin.com/company/vantage-studio",
      reference_notes: "",
    },
  };
}

export function sampleAgencyConsultingVslConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "vsl",
    niche: "agency_consulting",
    language: "English",
    heading: "Vantage Studio",
    color_scheme: "Dark Mode",
    hero_statement: "The three things every unignorable brand gets right.",
    features: "Brand strategy, Identity systems, Websites that convert",
    benefits: "Clarity first, Craft always, Results you can measure",
    contact_details: "hello@vantage.studio",
    cta_link: "https://vantage.studio/diagnostic",
    include_faq: false,
    video_link: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    local_page_selections: {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    },
    services_config: null,
    business_details: null,
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Brands built to be unignorable.",
      founded_year: "",
      brand_voice: "sharp, confident, generous",
      metrics: "Brands launched: 140+\nAvg. conversion lift: 38%",
      team: "",
      testimonials: "",
      offer_headline: "Book the diagnostic.",
      offer_bullets: "45 minutes\nWritten read-out\nSix brands a year",
      offer_fine: "",
      gallery_notes: "Hero still: a single red poster on a black studio wall.",
      social_links: "",
      reference_notes: "",
    },
  };
}

// ---------------------------------------------------------------------------
// AI niches (premium-only, 2026-10-03). Mirrors gitpage's
// libs/premium/samples/inputs.js. The automation sample has no street
// address on purpose — AI firms are usually remote and the address is optional.

export function sampleAiConsultingLocalConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: "ai_consulting",
    language: "English",
    heading: "Meridian AI Advisory",
    color_scheme: "Standard",
    hero_statement: "Clear AI decisions for leadership teams.",
    features: "Readiness assessments, Roadmaps, Responsible AI",
    benefits: "Vendor-neutral, Senior-led, Measurable outcomes",
    contact_details: "hello@meridianai.example",
    cta_link: "https://meridianai.example/strategy-call",
    include_faq: true,
    video_link: "",
    local_page_selections: { index: true, services: true, contact: true, privacy: true, terms: true },
    services_config: {
      let_ai_do_services: false,
      services_list:
        "AI Readiness Assessment — data, process and people review with a prioritised findings report; AI Strategy & Roadmap — 12-month plan of use cases with owners, costs and risks; Governance & Responsible AI — usage policy, risk register and vendor evaluation; Leadership & Team Training — hands-on workshops for executives and frontline teams",
    },
    business_details: {
      business_name: "Meridian AI Advisory",
      business_street: "Level 12, 1 Martin Place",
      business_city: "Sydney",
      business_state: "NSW",
      business_country: "Australia",
      business_zip: "2000",
      business_phone: "+61 2 9000 4410",
      business_email: "hello@meridianai.example",
      google_rating: "",
      google_review_count: "",
      opening_hours: "Mon–Fri 9:00 AM – 5:30 PM",
    },
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "Clear AI decisions for leadership teams.",
      founded_year: "2021",
      brand_voice: "calm, senior, plain-spoken",
      metrics: "Organisations advised: 60+\nRoadmaps delivered: 45\nAvg. assessment: 3 weeks",
      team: "Dr. Hannah Cole | Principal Advisor | PhD Machine Learning · ex-Big Four AI lead | Leads strategy and board engagements.\nMarcus Webb | Governance Lead | CIPP/E · ISO 42001 implementer | Policy, risk and responsible-AI programmes.",
      testimonials: "Meridian gave our board a plan it could actually approve: three use cases, clear costs, clear risks. We started the first one the following month. | Elaine Porter | COO, Harbour Health\nThey talked us out of two expensive projects and into one that paid for itself in a quarter. | Raj Malhotra | CFO, Southline Logistics",
      offer_headline: "Start with an AI readiness assessment.",
      offer_bullets: "A findings report your board can act on\nYour top three use cases, costed and risk-rated\nNo vendor kickbacks — ever",
      offer_fine: "Fixed fee, agreed upfront.",
      gallery_notes: "Calm editorial business photography: a small leadership team around a table with a whiteboard of priorities; an advisor presenting in a glass meeting room; Sydney office windows at dusk. No robots, no glowing brains, no screens with fake code.",
      social_links: "LinkedIn | https://linkedin.com/company/meridian-ai-advisory",
      reference_notes: "",
      tools: "OpenAI, Anthropic Claude, Microsoft Copilot, Azure AI",
      case_studies: "Harbour Health | 3 use cases approved | Readiness assessment and roadmap for a 1,200-staff healthcare group; first pilot live within six weeks.\nSouthline Logistics | Payback in one quarter | Re-scoped an AI programme to a single document-processing use case.",
    },
  };
}

export function sampleAiConsultingVslConfig(): WebsiteConfig {
  return {
    ...sampleAiConsultingLocalConfig(),
    build_type: "vsl",
    hero_statement: "Where AI will — and won't — pay off in your business.",
    video_link: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    local_page_selections: { index: true, services: false, contact: false, privacy: false, terms: false },
    services_config: null,
    business_details: null,
  };
}

export function sampleAiAutomationLocalConfig(): WebsiteConfig {
  return {
    site_type: "LocalSite",
    build_type: "local",
    niche: "ai_automation",
    language: "English",
    heading: "Relay Automation Studio",
    color_scheme: "Dark Mode",
    hero_statement: "AI agents that give your team its hours back.",
    features: "AI agents, Workflow automation, Chat and voice bots",
    benefits: "Fewer missed leads, Less admin, Faster replies",
    contact_details: "build@relayautomation.example",
    cta_link: "https://relayautomation.example/audit",
    include_faq: true,
    video_link: "",
    local_page_selections: { index: true, services: true, contact: true, privacy: true, terms: true },
    services_config: {
      let_ai_do_services: false,
      services_list:
        "AI Lead Agent — qualifies and books inbound leads from your website, email and phone; Workflow Automation — intake, follow-ups, invoicing and reporting connected across your tools; Chat & Voice Assistants — website chat and phone answering trained on your business; Automation Audit — a walkthrough of your operations ranked by hours saved",
    },
    business_details: {
      business_name: "Relay Automation Studio",
      business_street: "",
      business_city: "",
      business_state: "",
      business_country: "",
      business_zip: "",
      business_phone: "+1 (415) 555-0136",
      business_email: "build@relayautomation.example",
      google_rating: "",
      google_review_count: "",
      opening_hours: "Mon–Fri 8:00 AM – 6:00 PM",
    },
    design_color_palette: "Modern / Startup",
    custom_colors: "",
    design_typography: "Professional / Corporate",
    design_layout: "Spacious",
    design_components: "Rounded & Soft",
    design_interactions: "Energetic",
    design_buttons: "Solid Primary",
    design_contact_form: "Centered Card",
    design_icons: "Heroicons Outline",
    astra_theme: false,
    quality: "premium",
    concept: null,
    hero_motion: null,
    include_form: true,
    include_chat: true,
    premium_details: {
      tagline: "AI agents and automations that give your team its hours back.",
      founded_year: "2023",
      brand_voice: "direct, practical, upbeat",
      metrics: "",
      team: "Jess Navarro | Founder · Automation Lead | Ex-RevOps lead, 9 years in sales operations | Scopes every build and owns the results.\nTomás Ilić | AI Engineer | Builds agents on OpenAI and Claude | Agents, integrations and testing.",
      testimonials: "The lead agent answers every enquiry in under a minute, day or night. We stopped losing the weekend leads. | Alana Brooks | Owner, Brooks Home Renovations\nOur month-end reporting used to take two people three days. Now it's in the inbox Monday morning. | Dev Patel | Operations Manager, Northgate Freight",
      offer_headline: "Get a free automation audit.",
      offer_bullets: "45-minute walkthrough of your operations\nYour top five automations, ranked by hours saved\nA fixed-scope quote for the first build",
      offer_fine: "Most first builds go live in 2–4 weeks.",
      gallery_notes: "Real-feeling studio photography, no robots or glowing brains: a small team at a desk with workflow diagrams on a big monitor; a business owner answering a phone in a busy workshop; a laptop on a café table at night with soft neon reflections.",
      social_links: "LinkedIn | https://linkedin.com/company/relay-automation\nYouTube | https://youtube.com/@relayautomation",
      reference_notes: "",
      tools: "n8n, Make, Zapier, OpenAI, Claude, Vapi, HubSpot",
      case_studies: "Brooks Home Renovations | Replies in under 1 minute | AI lead agent on website chat and SMS that qualifies jobs and books site visits.\nNorthgate Freight | 3 days → 2 hours reporting | Automated month-end reporting pulling from the TMS, accounting and email.\nLumen Dental | 40% fewer missed calls | Voice assistant that answers after hours and books into the practice calendar.",
    },
  };
}

export function sampleAiAutomationVslConfig(): WebsiteConfig {
  return {
    ...sampleAiAutomationLocalConfig(),
    build_type: "vsl",
    hero_statement: "Watch an AI agent qualify and book a lead in 60 seconds.",
    video_link: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    local_page_selections: { index: true, services: false, contact: false, privacy: false, terms: false },
    services_config: null,
    business_details: null,
  };
}
