import type {
  ApexgeoReasonCode,
  ProspectReportApexgeo,
  ProspectSectionKey,
  ProspectSectionResult,
} from "@/types";
import type { ApexgeoScan } from "./apexgeo-client";
import * as aiPresence from "./sections/ai-presence";
import * as aiReadiness from "./sections/ai-readiness";
import * as websitePerformance from "./sections/website-performance";

/**
 * Report sections 5, 7 and 8 — the ApexGEO ones. Pure: no server imports, so
 * the public page and the member view share `displaySections`.
 *
 * They are never in the runner's STORED_FACT_SECTIONS and never decide
 * whether a report is ready: the report is ready before the scan finishes,
 * and the ApexGEO poll worker fills them in afterwards.
 */

export const APEXGEO_SECTION_KEYS = ["website_performance", "ai_readiness", "ai_presence"] as const satisfies readonly ProspectSectionKey[];

const APEXGEO_KEYS: ReadonlySet<ProspectSectionKey> = new Set(APEXGEO_SECTION_KEYS);

export const isApexgeoSection = (key: ProspectSectionKey) => APEXGEO_KEYS.has(key);

/** Reasons shown on the report. Generic by design: a provider's own error text is logged, never shown. */
export const APEXGEO_REASON: Record<Exclude<ApexgeoReasonCode, "missing_input">, string> = {
  not_connected: "Not connected — add an ApexGEO key in Settings to measure this.",
  pending: "ApexGEO scan in progress.",
  out_of_credits: "ApexGEO account is out of credits.",
  timeout: "ApexGEO did not finish the scan in time.",
  failed: "The ApexGEO scan failed.",
  gate_off: "Prospecting was switched off before the ApexGEO scan finished.",
};

const STATUS_OF: Record<ApexgeoReasonCode, ProspectSectionResult["status"]> = {
  not_connected: "unavailable",
  pending: "unavailable",
  missing_input: "unavailable",
  out_of_credits: "unavailable",
  gate_off: "unavailable",
  timeout: "timeout",
  failed: "failed",
};

/** The three sections, not measured, for one reason. */
export function apexgeoPlaceholders(code: ApexgeoReasonCode, reason: string): ProspectSectionResult[] {
  return APEXGEO_SECTION_KEYS.map((key) => ({
    key,
    status: STATUS_OF[code],
    score: null,
    findings: [],
    reason,
    reasonCode: code,
    raw: {},
  }));
}

/** The three sections measured from a completed scan. */
export function apexgeoFromScan(scan: ApexgeoScan): ProspectSectionResult[] {
  return [websitePerformance.result(scan), aiReadiness.result(scan), aiPresence.result(scan)];
}

/** `sections` with its ApexGEO sections replaced by `next` (appended when absent). */
export function withApexgeoSections(
  sections: ProspectSectionResult[],
  next: ProspectSectionResult[],
): ProspectSectionResult[] {
  return [...sections.filter((s) => !isApexgeoSection(s.key)), ...next];
}

/**
 * A scan still `pending` this long after it started lost its poll chain
 * (QStash gave up on every retry). Shown as timed out rather than "in
 * progress" forever. The poll worker's own bound is ~10 minutes.
 */
export const PENDING_SHOWN_AS_TIMEOUT_MS = 30 * 60_000;

export function displaySections(
  sections: ProspectSectionResult[],
  apexgeo: Partial<ProspectReportApexgeo> | null | undefined,
  now = Date.now(),
): ProspectSectionResult[] {
  const started = startedMs(apexgeo?.startedAt);
  if (apexgeo?.status !== "pending" || started === null || now - started <= PENDING_SHOWN_AS_TIMEOUT_MS) {
    return sections;
  }
  const timedOut = new Map(apexgeoPlaceholders("timeout", APEXGEO_REASON.timeout).map((s) => [s.key, s]));
  return sections.map((s) => (s.reasonCode === "pending" ? timedOut.get(s.key) ?? s : s));
}

function startedMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const ts = v as { toMillis?: () => number } | null | undefined;
  return typeof ts?.toMillis === "function" ? ts.toMillis() : null;
}
