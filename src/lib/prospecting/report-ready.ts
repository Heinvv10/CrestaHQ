import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { mintReportShare, reportShareUrl } from "@/lib/prospecting/share";

/**
 * What the report worker does once a report is settled `ready` (Prospecting
 * PR 4): mint its share link, stamp the report id, headline and link on the
 * contact — `{{prospecting.headline}}` / `{{prospecting.reportUrl}}` read them
 * there — and fire `prospecting.report.ready`.
 *
 * Once per report: only the delivery that claimed the report `queued →
 * running` gets here, and a retry of a ready report is a no-op in the worker,
 * so a retry never mints a second share or fires twice.
 *
 * Never throws: the report is already settled, so every failure is logged,
 * never reported as a failed run. Without a link nothing fires — a workflow
 * must not send a prospect an empty report URL.
 */
export async function announceReadyReport(input: {
  reportId: string;
  subAccountId: string;
  agencyId: string;
  contactId: string;
  /** The report's requester; stamped on the share as its creator. */
  createdByUid: string;
  headline: string | null;
}): Promise<void> {
  const { reportId, subAccountId } = input;
  let url: string | null = null;
  try {
    const minted = await mintReportShare({ reportId, subAccountId, uid: input.createdByUid });
    if (typeof minted === "object") url = reportShareUrl(minted.token);
    else console.error("[prospecting/report] share not minted", reportId, minted);
  } catch (err) {
    console.error("[prospecting/report] share not minted", reportId, err);
  }

  try {
    await getAdminDb().doc(`contacts/${input.contactId}`).update({
      "prospecting.lastReportId": reportId,
      "prospecting.lastReportHeadline": input.headline,
      "prospecting.lastReportUrl": url,
    });
  } catch (err) {
    console.error("[prospecting/report] report not stamped on the contact", reportId, err);
    return;
  }
  if (!url) return;

  const outcome = await fireWorkflowTrigger({
    type: "prospecting.report.ready",
    subAccountId,
    agencyId: input.agencyId,
    contactId: input.contactId,
    context: { reportId },
  });
  if (outcome.reason === "error") {
    console.error("[prospecting/report] prospecting.report.ready trigger failed", reportId);
  }
}
