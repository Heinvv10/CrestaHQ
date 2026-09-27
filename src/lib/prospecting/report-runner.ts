import "server-only";

import { fetchHomepage } from "@/lib/get-leads/enrich";
import { withReportFetchSlot } from "./fetch-slots";
import type {
  ProspectReportInput,
  ProspectReportOutcome,
  ProspectSectionKey,
  ProspectSectionResult,
} from "@/types";
import { headline } from "./severity";
import type { ApexgeoConnection } from "./apexgeo-client";
import { startReportScan } from "./apexgeo-report";
import * as ads from "./sections/ads";
import * as businessDetails from "./sections/business-details";
import * as gbp from "./sections/gbp";
import * as leadCapture from "./sections/lead-capture";
import * as listings from "./sections/listings";
import * as reputation from "./sections/reputation";
import * as techStack from "./sections/tech-stack";
import type { CostKey, Homepage, Section, SectionInput } from "./sections/types";

/**
 * Runs one prospect report: fetches the homepage once, then every section in
 * parallel, each under its own budget inside a report-wide deadline (well
 * under the QStash callback limit). A section that throws is `failed`, one
 * that overruns is `timeout` — the runner never waits on a section that
 * ignores its signal. The report is `ready` when at least one section
 * measured something (see STORED_FACT_SECTIONS). Never throws. Page fetches
 * take a slot in the reports' own process-wide pool (fetch-slots.ts).
 *
 * Once the report is known to be `ready` it starts the report's ApexGEO scan
 * (`apexgeo-report.ts`) and appends sections 5/7/8 as placeholders — pending,
 * or unavailable with the reason. They never decide `ready`: the scan
 * finishes after the report does and the poll worker fills them in. The
 * scan is started only for a ready report, so a failed one (quota released)
 * never spends the agency's ApexGEO credits. It costs no report time to wait:
 * the scan itself runs asynchronously at ApexGEO either way.
 */

/** Plan order: sections 1, 2, 3, 4, 6, 9, 10. */
const SECTIONS: Section[] = [businessDetails, gbp, reputation, listings, techStack, ads, leadCapture];

/**
 * Sections that only restate facts already stored on the contact (CRM fields,
 * the Places rating saved at import). They are shown, but an `ok` from them
 * measured nothing new, so it cannot make a report `ready` on its own.
 */
const STORED_FACT_SECTIONS: ReadonlySet<ProspectSectionKey> = new Set(["business_details", "reputation"]);

export const SECTION_TIMEOUT_MS = 20_000;
export const REPORT_DEADLINE_MS = 100_000;
// Get Leads gives a homepage 5 s because it fetches dozens per search; a
// report fetches one, and every site-based section depends on it.
const HOMEPAGE_TIMEOUT_MS = 15_000;

export interface RunnerOptions {
  /** The sub-account's ApexGEO connection (null = not connected) and this report's id. */
  apexgeo?: { connection: ApexgeoConnection | null; reportId: string };
  sections?: Section[];
  sectionTimeoutMs?: number;
  deadlineMs?: number;
}

export async function runProspectReport(
  input: ProspectReportInput,
  opts: RunnerOptions = {},
): Promise<ProspectReportOutcome> {
  const cost: Record<string, number> = {};
  const count = (provider: CostKey, n = 1) => {
    cost[provider] = (cost[provider] ?? 0) + n;
  };
  try {
    const deadline = AbortSignal.timeout(opts.deadlineMs ?? REPORT_DEADLINE_MS);
    const business = { ...input, website: withScheme(input.website) };
    let homepage: Homepage | null = null;
    if (business.website) {
      count("http");
      const website = business.website;
      homepage = await withReportFetchSlot(
        () => fetchHomepage(website, deadline, undefined, HOMEPAGE_TIMEOUT_MS),
        deadline,
      );
      if (!homepage) {
        console.warn("[prospecting] homepage not fetched", { website });
      }
    }
    const sections = await Promise.all(
      (opts.sections ?? SECTIONS).map((section) =>
        runSection(
          section,
          { business, homepage, count },
          deadline,
          opts.sectionTimeoutMs ?? SECTION_TIMEOUT_MS,
        ),
      ),
    );
    const ready = sections.some((s) => s.status === "ok" && !STORED_FACT_SECTIONS.has(s.key));
    if (!ready) return { status: "failed", sections, headline: headline(sections), cost, apexgeo: null };
    const scan = await startReportScan(opts.apexgeo?.connection ?? null, business, opts.apexgeo?.reportId ?? "", deadline);
    if (scan.scanId) count("apexgeoScans");
    return {
      status: "ready",
      sections: [...sections, ...scan.sections],
      headline: headline(sections),
      cost,
      apexgeo: scan.scanId ? { scanId: scan.scanId } : null,
    };
  } catch (err) {
    console.error("[prospecting] report runner failed", err);
    return { status: "failed", sections: [], headline: null, cost, apexgeo: null };
  }
}

/** A stored website without a scheme ("example.co.za") is tried over HTTPS. */
function withScheme(website: string | null): string | null {
  const trimmed = website?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function runSection(
  section: Section,
  base: Omit<SectionInput, "signal">,
  deadline: AbortSignal,
  timeoutMs: number,
): Promise<ProspectSectionResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline]);
  // Registered before the section starts, so on abort this resolves ahead of
  // the section's own AbortError and the result is `timeout`, not `failed`.
  const timedOut = new Promise<ProspectSectionResult>((resolve) => {
    const fire = () =>
      resolve({
        key: section.key,
        status: "timeout",
        score: null,
        findings: [],
        reason: `No result within ${Math.round(timeoutMs / 1000)}s.`,
        raw: {},
      });
    if (signal.aborted) fire();
    else signal.addEventListener("abort", fire, { once: true });
  });
  try {
    return await Promise.race([section.run({ ...base, signal }), timedOut]);
  } catch (err) {
    // The error text stays in the log: the reason is shown on the shared report.
    console.error(`[prospecting] section ${section.key} failed`, err);
    return {
      key: section.key,
      status: "failed",
      score: null,
      findings: [],
      reason: "The check failed.",
      raw: {},
    };
  }
}
