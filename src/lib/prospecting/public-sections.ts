import type {
  ApexgeoReasonCode,
  ProspectFindingCode,
  ProspectSectionKey,
  ProspectSectionResult,
  ProspectSectionStatus,
} from "@/types";

/**
 * The public view of a report section: status, score, findings and a few
 * named `details`. Pure (no server imports) so the member report page can
 * render the same view as `/report/[token]`. Nothing reaches the public that
 * is not named here — `raw` is never passed through wholesale.
 */

/**
 * Per section, the scalar `raw` keys safe to show publicly. business_details
 * omits phone and address (copied from the CRM contact). "notMeasured" values
 * are kept here, so the member view shows what was not measured (decision
 * D2); `resolvePublicReport` drops them from the public page (C6).
 */
export const PUBLIC_RAW_KEYS: Record<ProspectSectionKey, readonly string[]> = {
  business_details: ["name", "website", "category", "https"],
  gbp: ["description"],
  reputation: ["rating", "reviewsCount", "velocity90d", "ownerReplyRate"],
  listings: [],
  website_performance: ["lcpSeconds", "fcpSeconds", "speedIndexSeconds", "tbtMs", "cls", "mobileViewport"],
  tech_stack: [],
  // Robots rules per AI crawler, as ApexGEO read them ("allowed" / "blocked" / "notMeasured").
  ai_readiness: ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "robotsTxt", "localBusinessSchema"],
  // Counts and the competitors named — never the answers' text or cited URLs,
  // and never the model ids (C4: members only, MEMBER_RAW_KEYS).
  ai_presence: ["mentionedIn", "answersMeasured", "topCompetitors"],
  ads: ["metaAdLibraryUrl", "googleAdsTransparencyUrl"],
  lead_capture: ["whatsapp", "booking", "contactForm", "phoneLink", "chatWidget"],
};

/** The member view (`serializeReport`): the public keys plus the models AI was asked. */
export const MEMBER_RAW_KEYS: Record<ProspectSectionKey, readonly string[]> = {
  ...PUBLIC_RAW_KEYS,
  ai_presence: [...PUBLIC_RAW_KEYS.ai_presence, "models"],
};

/** The directories `sections/listings.ts` checks — the only listing keys shown. */
export const LISTING_DIRECTORIES = ["Facebook", "Bing", "Yellow Pages SA", "Brabys", "Cylex"] as const;

const LISTING_STATUSES = new Set(["found", "not_found", "unknown"]);

export type Scalar = string | number | boolean | null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const MAX_QUESTIONS = 10;

/** Structured `raw` values flattened into named scalars. Again, only what is named. */
const PUBLIC_DERIVED: Partial<Record<ProspectSectionKey, (raw: Record<string, unknown>) => Record<string, Scalar>>> = {
  gbp: (raw): Record<string, Scalar> => {
    const details = obj(raw.details);
    if (Object.keys(details).length === 0) return {};
    const phone = details.nationalPhoneNumber;
    return {
      hoursListed: arr(obj(details.regularOpeningHours).weekdayDescriptions).length > 0,
      photoCount: arr(details.photos).length,
      phoneListed: typeof phone === "string" && phone.trim() !== "",
    };
  },
  listings: (raw) => {
    const out: Record<string, Scalar> = {};
    for (const c of arr(raw.checks).map(obj)) {
      const dir = c.directory;
      if (
        typeof dir === "string" &&
        (LISTING_DIRECTORIES as readonly string[]).includes(dir) &&
        typeof c.status === "string" &&
        LISTING_STATUSES.has(c.status)
      ) {
        out[dir] = c.status;
      }
    }
    return out;
  },
  tech_stack: (raw) => {
    const names = arr(raw.detected)
      .map((t) => obj(t).name)
      .filter((n): n is string => typeof n === "string" && n !== "");
    return { technologies: names.length > 0 ? names.join(", ") : null };
  },
  // The questions put to AI (C7), as question1, question2… Their text only:
  // the competitors named per question stay in `raw`.
  ai_presence: (raw) => {
    const out: Record<string, Scalar> = {};
    arr(raw.prompts)
      .map((p) => obj(p).text)
      .filter((t): t is string => typeof t === "string" && t.trim() !== "")
      .slice(0, MAX_QUESTIONS)
      .forEach((text, i) => (out[`question${i + 1}`] = text.slice(0, 200)));
    return out;
  },
};

export interface PublicReportSection {
  key: ProspectSectionKey;
  status: ProspectSectionStatus;
  score: number | null;
  /** `impact` and `cta` are null on findings scored before R0. */
  findings: { code: ProspectFindingCode; text: string; impact: string | null; cta: string | null }[];
  reason: string | null;
  /** ApexGEO sections: why not measured, for the member view's connect link. */
  reasonCode: ApexgeoReasonCode | null;
  details: Record<string, Scalar>;
}

const REASON_CODES: ReadonlySet<string> = new Set<ApexgeoReasonCode>([
  "not_connected", "pending", "missing_input", "out_of_credits", "timeout", "failed", "gate_off",
]);

const isScalar = (v: unknown): v is Scalar =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * `keys` is the raw-key whitelist: PUBLIC_RAW_KEYS unless the member view
 * passes MEMBER_RAW_KEYS.
 *
 * `showName: false` drops business_details `name` and the ads Meta Ad Library
 * link (it searches by that name): for a contact that is not a business (no
 * company, not a prospecting import) the name may be a person's.
 */
const NAME_BEARING_KEYS = new Set(["name", "metaAdLibraryUrl"]);

export function publicSection(
  s: ProspectSectionResult,
  opts: { showName: boolean; keys?: Record<ProspectSectionKey, readonly string[]> },
): PublicReportSection {
  const raw = obj(s.raw);
  const details: Record<string, Scalar> = {};
  for (const k of (opts.keys ?? PUBLIC_RAW_KEYS)[s.key] ?? []) {
    if (NAME_BEARING_KEYS.has(k) && !opts.showName) continue;
    if (isScalar(raw[k])) details[k] = raw[k];
  }
  Object.assign(details, PUBLIC_DERIVED[s.key]?.(raw) ?? {});
  return {
    key: s.key,
    status: s.status,
    score: typeof s.score === "number" ? s.score : null,
    findings: (s.findings ?? []).map((f) => ({
      code: f.code,
      text: String(f.text),
      impact: typeof f.impact === "string" ? f.impact : null,
      cta: typeof f.cta === "string" ? f.cta : null,
    })),
    reason: typeof s.reason === "string" && s.reason ? s.reason : null,
    reasonCode: typeof s.reasonCode === "string" && REASON_CODES.has(s.reasonCode) ? s.reasonCode : null,
    details,
  };
}
