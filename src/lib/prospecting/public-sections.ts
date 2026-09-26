import type {
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
 * omits phone and address (copied from the CRM contact). "notMeasured" keys
 * are kept: the report says plainly what it did not measure (decision D2).
 */
export const PUBLIC_RAW_KEYS: Record<ProspectSectionKey, readonly string[]> = {
  business_details: ["name", "website", "category", "https"],
  gbp: ["description"],
  reputation: ["rating", "reviewsCount", "velocity90d", "ownerReplyRate"],
  listings: [],
  website_performance: [],
  tech_stack: [],
  ai_readiness: [],
  ai_presence: [],
  ads: ["metaAdLibraryUrl", "googleAdsTransparencyUrl"],
  lead_capture: ["whatsapp", "booking", "contactForm", "phoneLink", "chatWidget"],
};

/** The directories `sections/listings.ts` checks — the only listing keys shown. */
export const LISTING_DIRECTORIES = ["Facebook", "Bing", "Yellow Pages SA", "Brabys", "Cylex"] as const;

const LISTING_STATUSES = new Set(["found", "not_found", "unknown"]);

export type Scalar = string | number | boolean | null;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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
};

export interface PublicReportSection {
  key: ProspectSectionKey;
  status: ProspectSectionStatus;
  score: number | null;
  findings: { code: ProspectFindingCode; text: string }[];
  reason: string | null;
  details: Record<string, Scalar>;
}

const isScalar = (v: unknown): v is Scalar =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * `showName: false` drops business_details `name`: for a contact that is not
 * a business (no company, not a prospecting import) it is a person's name.
 */
export function publicSection(
  s: ProspectSectionResult,
  opts: { showName: boolean },
): PublicReportSection {
  const raw = obj(s.raw);
  const details: Record<string, Scalar> = {};
  for (const k of PUBLIC_RAW_KEYS[s.key] ?? []) {
    if (k === "name" && !opts.showName) continue;
    if (isScalar(raw[k])) details[k] = raw[k];
  }
  Object.assign(details, PUBLIC_DERIVED[s.key]?.(raw) ?? {});
  return {
    key: s.key,
    status: s.status,
    score: typeof s.score === "number" ? s.score : null,
    findings: (s.findings ?? []).map((f) => ({ code: f.code, text: String(f.text) })),
    reason: typeof s.reason === "string" && s.reason ? s.reason : null,
    details,
  };
}
