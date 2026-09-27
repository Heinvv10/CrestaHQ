import type {
  ProspectFinding,
  ProspectReportInput,
  ProspectSectionKey,
  ProspectSectionResult,
} from "@/types";

/** The business homepage, fetched once per report by the runner. */
export interface Homepage {
  html: string;
  /** Final URL after redirects — its protocol says whether the site is on HTTPS. */
  url: string;
}

/** Provider calls counted into `ProspectReportDoc.cost`. */
export type CostKey = "placesDetails" | "http" | "apexgeoScans";

export interface SectionInput {
  business: ProspectReportInput;
  /** Null when the business has no website or it could not be fetched. */
  homepage: Homepage | null;
  /** Fires when this section's budget (or the report's deadline) runs out. */
  signal: AbortSignal;
  /** Records outbound calls against the report's cost. */
  count: (provider: CostKey, n?: number) => void;
}

export interface Section {
  key: ProspectSectionKey;
  run: (input: SectionInput) => Promise<ProspectSectionResult>;
}

/** What every pure `score(raw)` returns. */
export interface Scored {
  score: number;
  findings: ProspectFinding[];
}

export function measured(
  key: ProspectSectionKey,
  scored: Scored,
  raw: Record<string, unknown>,
): ProspectSectionResult {
  return { key, status: "ok", score: scored.score, findings: scored.findings, raw };
}

export function unavailable(
  key: ProspectSectionKey,
  reason: string,
  raw: Record<string, unknown> = {},
): ProspectSectionResult {
  return { key, status: "unavailable", score: null, findings: [], reason, raw };
}
