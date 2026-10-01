import type { PublicReportSection, Scalar } from "@/lib/prospecting/public-sections";
import type { ProspectSectionKey } from "@/types";

/**
 * Which section cards a report shows, in what order, with which facts, and
 * how each fact reads. Pure, so the page's `ReportSections` and the PDF (R5)
 * list the same rows from the same function.
 */

export const LABELS: Record<ProspectSectionKey, string> = {
  business_details: "Business details",
  gbp: "Google Business Profile",
  reputation: "Reviews & reputation",
  listings: "Directory listings",
  website_performance: "Website speed",
  tech_stack: "Website technology",
  ai_readiness: "AI readiness",
  ai_presence: "AI search presence",
  ads: "Advertising",
  lead_capture: "Lead capture",
};

export const STATUS_NOTE: Record<Exclude<PublicReportSection["status"], "ok">, string> = {
  unavailable: "Could not be measured",
  timeout: "Timed out",
  failed: "Check failed",
};

/** Human labels for `details` keys. Listing keys are directory names and label themselves. */
export const DETAIL_LABELS: Record<string, string> = {
  name: "Business name",
  website: "Website",
  category: "Category",
  https: "Website on HTTPS",
  description: "Business description",
  hoursListed: "Opening hours listed",
  photoCount: "Photos found",
  phoneListed: "Phone number listed",
  rating: "Google rating",
  reviewsCount: "Google reviews",
  velocity90d: "New reviews (last 90 days)",
  ownerReplyRate: "Owner reply rate",
  technologies: "Detected",
  metaAdLibraryUrl: "Meta Ad Library",
  googleAdsTransparencyUrl: "Google Ads Transparency Center",
  whatsapp: "WhatsApp click-to-chat",
  booking: "Online booking",
  contactForm: "Contact form",
  phoneLink: "Tap-to-call link",
  chatWidget: "Live chat",
  lcpSeconds: "Main content shown on a phone (s)",
  fcpSeconds: "First content shown (s)",
  speedIndexSeconds: "Speed index (s)",
  tbtMs: "Blocking time (ms)",
  cls: "Layout shift",
  mobileViewport: "Mobile-friendly layout",
  GPTBot: "ChatGPT crawler (GPTBot)",
  ClaudeBot: "Claude crawler (ClaudeBot)",
  PerplexityBot: "Perplexity crawler",
  "Google-Extended": "Google AI (Google-Extended)",
  robotsTxt: "robots.txt",
  localBusinessSchema: "LocalBusiness structured data",
  mentionedIn: "AI answers naming the business",
  answersMeasured: "AI answers checked",
  models: "AI models asked",
  topCompetitors: "Businesses named instead",
};

/** Only these details render as links; any other text stays text. */
export const LINK_KEYS = new Set(["website", "metaAdLibraryUrl", "googleAdsTransparencyUrl"]);

const WORD_VALUE: Record<string, string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  found: "Found",
  missing: "Missing",
};

const LISTING_STATUS: Record<string, string> = {
  found: "Listed",
  not_found: "No match",
  unknown: "Could not check",
};

/** How a fact's value reads. A link key's text; whether it links is the caller's (`LINK_KEYS`). */
export function detailText(name: string, section: ProspectSectionKey, value: Scalar): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === "notMeasured") return "Not measured";
  if (section === "listings" && typeof value === "string") return LISTING_STATUS[value] ?? value;
  if (section === "ai_readiness" && typeof value === "string") return WORD_VALUE[value] ?? value;
  if (LINK_KEYS.has(name) && typeof value === "string" && /^https:\/\//i.test(value)) {
    return name === "website" ? value : "Check manually";
  }
  return String(value);
}

/** Raw metrics: member view only, behind the "show everything" toggle (SOW, section cards). */
const RAW_METRIC_KEYS = new Set(["fcpSeconds", "speedIndexSeconds", "tbtMs", "cls"]);

/** Manual-check links: members only (C6). */
const MANUAL_CHECK_KEYS = new Set(["metaAdLibraryUrl", "googleAdsTransparencyUrl"]);

/** AI presence details the card renders as sentences rather than rows. */
const AI_PRESENCE_KEYS = new Set(["mentionedIn", "answersMeasured", "topCompetitors"]);

const MAX_FACTS = 3;

/**
 * The rows a card lists. By default at most three plain-language facts: no
 * raw metrics, nothing unmeasured, no manual-check links, only directories
 * the business was found in. `showAll` (the member toggle) lists every row.
 */
function factsOf(s: PublicReportSection, showAll: boolean): [string, Scalar][] {
  // Questions and the AI presence counts render as sentences (AiPresenceBody), never as rows too.
  const rows = Object.entries(s.details).filter(
    ([k, v]) => v !== null && !/^question\d+$/.test(k) && !(s.key === "ai_presence" && AI_PRESENCE_KEYS.has(k)),
  );
  if (showAll) return rows;
  return rows
    .filter(
      ([k, v]) =>
        v !== "notMeasured" &&
        !RAW_METRIC_KEYS.has(k) &&
        !MANUAL_CHECK_KEYS.has(k) &&
        (s.key !== "listings" || v === "found"),
    )
    .slice(0, MAX_FACTS);
}

/** Worst score first; unscored and unmeasured sections after, in stored order. */
function checkUpOrder(sections: PublicReportSection[]): PublicReportSection[] {
  const scoreOf = (s: PublicReportSection) => (s.status === "ok" && s.score !== null ? s.score : 101);
  return sections.map((s, i) => ({ s, i })).sort((a, b) => scoreOf(a.s) - scoreOf(b.s) || a.i - b.i).map(({ s }) => s);
}

export interface SectionRow {
  s: PublicReportSection;
  label: string;
  facts: [string, Scalar][];
  scored: boolean;
}

/**
 * The cards of "the rest of your check-up". `hideEmpty` (public page and
 * PDF) drops a section that came back `ok` with no score, no findings and no
 * rows to show; a failed/timed-out/unavailable one still shows its reason.
 */
export function sectionRows(
  sections: PublicReportSection[],
  { showAll = false, hideEmpty = false }: { showAll?: boolean; hideEmpty?: boolean } = {},
): SectionRow[] {
  return checkUpOrder(sections)
    .map((s) => ({
      s,
      label: LABELS[s.key] ?? s.key,
      facts: factsOf(s, showAll),
      scored: s.status === "ok" && s.score !== null,
    }))
    .filter((r) => !hideEmpty || r.s.status !== "ok" || r.scored || r.s.findings.length > 0 || r.facts.length > 0);
}
