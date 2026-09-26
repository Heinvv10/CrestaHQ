import "server-only";

import type { ProspectReportInput, ProspectReportOutcome } from "@/types";

// CONTRACT STUB — replaced by the runner build (sections + severity).
export async function runProspectReport(
  _input: ProspectReportInput,
): Promise<ProspectReportOutcome> {
  return { status: "failed", sections: [], headline: null, cost: {} };
}
