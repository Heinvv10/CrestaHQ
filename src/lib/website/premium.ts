import type {
  HeroMotion,
  WebsiteConfig,
  WebsitePremiumDetails,
} from "@/types/website";

/**
 * Premium build helpers shared by the website form (client), the validator,
 * and the gitpage client (server). The form stores multi-value premium
 * inputs as plain text — one entry per line, " | " between columns — and
 * this module is the ONE place that turns them into the typed arrays
 * gitpage's `premium` block expects (see LEADSTACK_INTEGRATION.md §14).
 *
 * Limits mirror gitpage's `libs/premium/validate-input.js` exactly, so a
 * config that passes here is accepted there.
 */

export const PREMIUM_LIMITS = {
  tagline: 120,
  brandVoice: 5,
  brandVoiceWord: 30,
  metrics: 4,
  metricLabel: 40,
  metricValue: 30,
  team: 6,
  teamName: 60,
  teamRole: 50,
  teamCredentials: 120,
  teamSpec: 160,
  testimonials: 6,
  testimonialQuote: 420,
  testimonialName: 60,
  testimonialRole: 60,
  offerHeadline: 110,
  offerBullets: 5,
  offerBullet: 120,
  offerFine: 160,
  galleryNotes: 600,
  socialLinks: 6,
  socialLabel: 30,
  referenceNotes: 4000,
  tools: 12,
  toolName: 40,
  caseStudies: 4,
  caseClient: 40,
  caseResult: 30,
  caseDetail: 240,
} as const;

export const HERO_MOTION_OPTIONS: { value: HeroMotion; label: string; hint: string }[] = [
  { value: "still", label: "Still", hint: "One hero photograph. Fastest, lightest." },
  { value: "loop", label: "Loop", hint: "A short ambient video loop over the hero (falls back to the still)." },
  { value: "atmosphere", label: "Atmosphere", hint: "Still photo with slow light/grain motion in CSS." },
];

const lines = (v: string | null | undefined): string[] =>
  (v ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const cols = (line: string): string[] => line.split("|").map((c) => c.trim());

const HTTPS_RE = /^https:\/\/[^\s/]+(\/\S*)?$/i;

export interface PremiumMetric { label: string; value: string }
export interface PremiumTeamMember { name: string; role?: string; credentials?: string; spec?: string }
export interface PremiumTestimonial { quote: string; name: string; role?: string }
export interface PremiumSocialLink { label: string; url: string }
export interface PremiumCaseStudy { client: string; result: string; detail?: string }

export function parseTools(text: string | null | undefined): string[] {
  return (text ?? "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
}

export function parseCaseStudies(text: string | null | undefined): PremiumCaseStudy[] {
  return lines(text).map((l) => {
    const [client = "", result = "", detail = ""] = cols(l);
    return { client, result, ...(detail && { detail }) };
  });
}

/** The `premium` request block, minus concept/mode/accent/heroMotion (set by the client). */
export interface PremiumDetailsPayload {
  tagline?: string;
  foundedYear?: number;
  brandVoice?: string[];
  metrics?: PremiumMetric[];
  team?: PremiumTeamMember[];
  testimonials?: PremiumTestimonial[];
  offer?: { headline?: string; bullets?: string[]; fine?: string };
  galleryNotes?: string;
  socialLinks?: PremiumSocialLink[];
  tools?: string[];
  caseStudies?: PremiumCaseStudy[];
}

export function parseMetrics(text: string): PremiumMetric[] {
  return lines(text).map((l) => {
    const i = l.lastIndexOf(":");
    if (i <= 0) return { label: l, value: "" };
    return { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  });
}

export function parseTeam(text: string): PremiumTeamMember[] {
  return lines(text).map((l) => {
    const [name = "", role = "", credentials = "", spec = ""] = cols(l);
    return {
      name,
      ...(role && { role }),
      ...(credentials && { credentials }),
      ...(spec && { spec }),
    };
  });
}

export function parseTestimonials(text: string): PremiumTestimonial[] {
  return lines(text).map((l) => {
    const [quote = "", name = "", role = ""] = cols(l);
    return { quote, name, ...(role && { role }) };
  });
}

export function parseSocialLinks(text: string): PremiumSocialLink[] {
  return lines(text).map((l) => {
    const [label = "", url = ""] = cols(l);
    return { label, url };
  });
}

export function parseBrandVoice(text: string): string[] {
  return (text ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * HARDENING (not upstream): fields the form only shows for some niches. A
 * value typed under one niche stays in the config when the operator switches
 * to another, so validation and the payload must ignore it the same way the
 * form hides it; otherwise it can fail with an error no field displays, or
 * ship to gitpage unseen. A missing niche (generic build) shows none of them.
 */
export const NICHE_ONLY_DETAIL_FIELDS = {
  tools: ["ai_consulting", "ai_automation"],
  case_studies: ["ai_consulting", "ai_automation", "agency_consulting"],
} as const satisfies Partial<Record<keyof WebsitePremiumDetails, readonly string[]>>;

export function premiumDetailAppliesToNiche(
  field: keyof WebsitePremiumDetails,
  niche: string | null | undefined,
): boolean {
  const only = (NICHE_ONLY_DETAIL_FIELDS as Record<string, readonly string[] | undefined>)[field];
  return !only || (!!niche && only.includes(niche));
}

/**
 * Validate the operator's premium details. Returns `{ field: message }` keyed
 * by the WebsitePremiumDetails field name (empty = valid). Blank fields are
 * always valid — everything here is optional.
 */
export function validatePremiumDetails(
  d: WebsitePremiumDetails,
  niche: string | null, // HARDENING: required; niche-only fields are skipped off-niche
): Record<string, string> {
  const errors: Record<string, string> = {};
  const L = PREMIUM_LIMITS;

  if (d.tagline && d.tagline.length > L.tagline)
    errors.tagline = `Keep it under ${L.tagline} characters.`;

  if (d.founded_year.trim()) {
    const y = Number(d.founded_year.trim());
    const max = new Date().getFullYear();
    if (!Number.isInteger(y) || y < 1800 || y > max)
      errors.founded_year = `Enter a four-digit year between 1800 and ${max}.`;
  }

  const voice = parseBrandVoice(d.brand_voice);
  if (voice.length > L.brandVoice)
    errors.brand_voice = `Up to ${L.brandVoice} words, comma-separated.`;
  else if (voice.some((w) => w.length > L.brandVoiceWord))
    errors.brand_voice = `Each word under ${L.brandVoiceWord} characters.`;

  const metrics = parseMetrics(d.metrics);
  if (metrics.length > L.metrics)
    errors.metrics = `Up to ${L.metrics} metrics (one per line).`;
  else if (
    metrics.some(
      (m) =>
        !m.label || !m.value || m.label.length > L.metricLabel || m.value.length > L.metricValue,
    )
  )
    errors.metrics = `Each line as "Label: Value" (label ≤${L.metricLabel}, value ≤${L.metricValue}).`;

  const team = parseTeam(d.team);
  if (team.length > L.team) errors.team = `Up to ${L.team} people (one per line).`;
  else if (
    team.some(
      (m) =>
        !m.name ||
        m.name.length > L.teamName ||
        (m.role ?? "").length > L.teamRole ||
        (m.credentials ?? "").length > L.teamCredentials ||
        (m.spec ?? "").length > L.teamSpec,
    )
  )
    errors.team = `Each line as "Name | Role | Credentials | What they do" (name ≤${L.teamName}, role ≤${L.teamRole}, credentials ≤${L.teamCredentials}, description ≤${L.teamSpec}).`;

  const testimonials = parseTestimonials(d.testimonials);
  if (testimonials.length > L.testimonials)
    errors.testimonials = `Up to ${L.testimonials} testimonials (one per line).`;
  else if (
    testimonials.some(
      (t) =>
        !t.quote ||
        !t.name ||
        t.quote.length > L.testimonialQuote ||
        t.name.length > L.testimonialName ||
        (t.role ?? "").length > L.testimonialRole,
    )
  )
    errors.testimonials = `Each line as "Quote | Name | Role" (quote ≤${L.testimonialQuote}, name ≤${L.testimonialName}).`;

  if (d.offer_headline.length > L.offerHeadline)
    errors.offer_headline = `Keep it under ${L.offerHeadline} characters.`;
  const bullets = lines(d.offer_bullets);
  if (bullets.length > L.offerBullets)
    errors.offer_bullets = `Up to ${L.offerBullets} bullets (one per line).`;
  else if (bullets.some((b) => b.length > L.offerBullet))
    errors.offer_bullets = `Each bullet under ${L.offerBullet} characters.`;
  if (d.offer_fine.length > L.offerFine)
    errors.offer_fine = `Keep it under ${L.offerFine} characters.`;
  if (d.gallery_notes.length > L.galleryNotes)
    errors.gallery_notes = `Keep it under ${L.galleryNotes} characters.`;

  const socials = parseSocialLinks(d.social_links);
  if (socials.length > L.socialLinks)
    errors.social_links = `Up to ${L.socialLinks} links (one per line).`;
  else if (
    socials.some((s) => !s.label || s.label.length > L.socialLabel || !HTTPS_RE.test(s.url))
  )
    errors.social_links = `Each line as "Label | https://…" (label ≤${L.socialLabel}, https URL).`;

  if (d.reference_notes.length > L.referenceNotes)
    errors.reference_notes = `Keep it under ${L.referenceNotes} characters.`;

  const tools = premiumDetailAppliesToNiche("tools", niche) ? parseTools(d.tools) : [];
  if (tools.length > L.tools) errors.tools = `Up to ${L.tools} tools, comma-separated.`;
  else if (tools.some((t) => t.length > L.toolName)) errors.tools = `Each tool name under ${L.toolName} characters.`;

  const cases = premiumDetailAppliesToNiche("case_studies", niche) ? parseCaseStudies(d.case_studies) : [];
  if (cases.length > L.caseStudies) errors.case_studies = `Up to ${L.caseStudies} case studies (one per line).`;
  else if (
    cases.some(
      (c) =>
        !c.client || !c.result || c.client.length > L.caseClient || c.result.length > L.caseResult || (c.detail ?? "").length > L.caseDetail,
    )
  )
    errors.case_studies = `Each line as "Client | Result | What you did" (client ≤${L.caseClient}, result ≤${L.caseResult}, details ≤${L.caseDetail}).`;

  return errors;
}

/**
 * Build the typed `premium` block (details only). Blank inputs are omitted
 * so gitpage's skeleton fills them from the niche defaults rather than
 * receiving empty strings.
 */
export function premiumDetailsPayload(
  d: WebsitePremiumDetails | null | undefined,
  niche: string | null, // HARDENING: required; niche-only fields are omitted off-niche
): PremiumDetailsPayload {
  if (!d) return {};
  const out: PremiumDetailsPayload = {};
  if (d.tagline.trim()) out.tagline = d.tagline.trim();
  const year = Number(d.founded_year.trim());
  if (d.founded_year.trim() && Number.isInteger(year)) out.foundedYear = year;
  const voice = parseBrandVoice(d.brand_voice);
  if (voice.length) out.brandVoice = voice;
  const metrics = parseMetrics(d.metrics).filter((m) => m.label && m.value);
  if (metrics.length) out.metrics = metrics;
  const team = parseTeam(d.team).filter((m) => m.name);
  if (team.length) out.team = team;
  const testimonials = parseTestimonials(d.testimonials).filter((t) => t.quote && t.name);
  if (testimonials.length) out.testimonials = testimonials;
  const bullets = lines(d.offer_bullets);
  if (d.offer_headline.trim() || bullets.length || d.offer_fine.trim()) {
    out.offer = {
      ...(d.offer_headline.trim() && { headline: d.offer_headline.trim() }),
      ...(bullets.length && { bullets }),
      ...(d.offer_fine.trim() && { fine: d.offer_fine.trim() }),
    };
  }
  if (d.gallery_notes.trim()) out.galleryNotes = d.gallery_notes.trim();
  const socials = parseSocialLinks(d.social_links).filter((s) => s.label && s.url);
  if (socials.length) out.socialLinks = socials;
  const tools = premiumDetailAppliesToNiche("tools", niche) ? parseTools(d.tools) : [];
  if (tools.length) out.tools = tools;
  const cases = premiumDetailAppliesToNiche("case_studies", niche)
    ? parseCaseStudies(d.case_studies).filter((c) => c.client && c.result)
    : [];
  if (cases.length) out.caseStudies = cases;
  return out;
}

/** gitpage `premium.mode` from the existing colour-scheme picker. */
export function premiumModeFor(config: Pick<WebsiteConfig, "color_scheme">): "light" | "dark" {
  return config.color_scheme === "Dark Mode" ? "dark" : "light";
}
