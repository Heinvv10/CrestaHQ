import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import type { ApexgeoReasonCode, ProspectReportInput, ProspectSectionResult } from "@/types";
import { startScan, type ApexgeoConnection } from "./apexgeo-client";
import { APEXGEO_REASON, apexgeoPlaceholders, withApexgeoSections } from "./apexgeo-sections";
import { headline } from "./severity";

/**
 * The two phases of a report's ApexGEO scan (decision D1).
 *
 * Phase 1, inside the report worker: `startReportScan` POSTs the scan with
 * `external_ref` = the report id, so a retry replays it and nothing is
 * charged twice. The report is written `ready` with the three sections
 * `pending`, then `schedulePoll(reportId, 0)` queues the first poll.
 *
 * Phase 2, `/api/automations/prospecting/apexgeo`: polls the scan until it
 * completes, fails or runs out of attempts, and settles the sections with
 * `settleApexgeo` — a transaction that only lands on a report still `ready`
 * with its scan `pending` at the attempt the poll expected.
 */

export const APEXGEO_POLL_PATH = "/api/automations/prospecting/apexgeo";

/**
 * Delay before poll n (seconds). ~47 s is a typical scan; the chain ends
 * about 10 minutes after the scan started, when the last poll still finds
 * it running.
 */
export const POLL_DELAYS_S = [45, 45, 90, 180, 240] as const;

export type StartOutcome =
  | { scanId: string; sections: ProspectSectionResult[] }
  | { scanId: null; sections: ProspectSectionResult[] };

/** Never throws: every refusal becomes three honest placeholder sections. */
export async function startReportScan(
  conn: ApexgeoConnection | null,
  business: ProspectReportInput,
  reportId: string,
  signal?: AbortSignal,
): Promise<StartOutcome> {
  const none = (code: ApexgeoReasonCode, reason = APEXGEO_REASON[code as keyof typeof APEXGEO_REASON]) => ({
    scanId: null,
    sections: apexgeoPlaceholders(code, reason),
  });
  if (!conn) return none("not_connected");
  // Never a guessed niche or place (decision D4).
  const missing = [
    !business.website && "website",
    !business.category && "category",
    !business.city && "city",
  ].filter((m): m is string => Boolean(m));
  if (missing.length > 0) {
    return none("missing_input", `Not measured: the contact has no ${listOf(missing)} for the scan.`);
  }
  const res = await startScan(
    conn,
    {
      url: business.website!,
      businessName: business.name,
      niche: business.category!,
      city: business.city!,
      country: business.countryCode ?? "ZA",
      externalRef: `leadstack:report:${reportId}`,
    },
    signal,
  );
  if (res.ok) return { scanId: res.scanId, sections: apexgeoPlaceholders("pending", APEXGEO_REASON.pending) };
  console.error("[prospecting/apexgeo] scan not started", reportId, res.error);
  return none(res.error.kind === "insufficient_credits" ? "out_of_credits" : "failed");
}

const listOf = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** Queue poll `attempt`. The dedup id makes a repeat publish of the same poll one message. */
export async function schedulePoll(reportId: string, attempt: number): Promise<boolean> {
  const published = await publishCallback({
    pathname: APEXGEO_POLL_PATH,
    body: { reportId, attempt },
    delaySeconds: POLL_DELAYS_S[attempt],
    deduplicationId: `apexgeo_${reportId}_${attempt}`,
  });
  return published !== null;
}

/**
 * Replace the report's ApexGEO sections and recompute its headline, only if
 * the report is still `ready` with its scan `pending` (and, with `attempt`,
 * at that poll). Returns whether it wrote — false means someone settled it first.
 */
export async function settleApexgeo(
  reportId: string,
  opts: {
    attempt?: number;
    sections: ProspectSectionResult[];
    status: "done" | "failed" | "timeout" | "stopped";
    credits?: number | null;
  },
): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`prospectReports/${reportId}`);
  return db.runTransaction(async (tx) => {
    const report = (await tx.get(ref)).data();
    if (!isPendingAt(report, opts.attempt)) return false;
    const sections = withApexgeoSections((report!.sections ?? []) as ProspectSectionResult[], opts.sections);
    tx.update(ref, {
      sections,
      headline: headline(sections),
      "apexgeo.status": opts.status,
      "apexgeo.settledAt": FieldValue.serverTimestamp(),
      ...(typeof opts.credits === "number" ? { "cost.apexgeoCredits": opts.credits } : {}),
    });
    return true;
  });
}

/** Record that poll `attempt` found the scan still running and `attempt + 1` is queued. */
export async function advancePoll(reportId: string, attempt: number): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`prospectReports/${reportId}`);
  return db.runTransaction(async (tx) => {
    if (!isPendingAt((await tx.get(ref)).data(), attempt)) return false;
    tx.update(ref, { "apexgeo.attempts": attempt + 1 });
    return true;
  });
}

export function isPendingAt(report: FirebaseFirestore.DocumentData | undefined, attempt?: number): boolean {
  return (
    report?.status === "ready" &&
    report.apexgeo?.status === "pending" &&
    (attempt === undefined || report.apexgeo.attempts === attempt)
  );
}
