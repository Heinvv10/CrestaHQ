import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";

/**
 * The report announce (prospect report redesign, C1): once a report is
 * FINAL, stamp its headline on the contact and fire
 * `prospecting.report.ready` — so the outreach headline is the page's.
 *
 * The report worker mints the share and stamps `lastReportId` /
 * `lastReportUrl` at `ready` (the link is stable from then on); a member's
 * re-mint or revoke keeps `lastReportUrl` in step (share.ts). Every
 * final-settle transaction writes `announceDueAt` — the poll's done, failed,
 * timeout and stopped, the worker's own settle when no poll could be queued,
 * ready with no scan, and the sweep — and then calls this. The poll's
 * no-longer-pending path and the 15-minute sweep call it again for any
 * report due but unannounced, so a crash between settle and `announcedAt`
 * is finished by whichever comes next.
 *
 * Only a report the R0 worker claimed (`announceProtocol: 1`) is announced:
 * every older report already fired at ready, and a second message to the
 * prospect is the failure this avoids. A missing `announceDueAt` never means
 * "not yet announced" on its own.
 *
 * At least once, deduped at enrolment: the trigger carries
 * `enrolmentKey = report:<id>`, so a re-fire after a crash between the fire
 * and `announcedAt` enrols nobody twice.
 */

export const ANNOUNCE_PROTOCOL = 1;

export type AnnounceReason = "fired" | "superseded" | "no live link";

/**
 * Announce one report if it is due. Returns what it recorded, or null when
 * the report was not due (or the fire errored, so the next caller retries).
 * Never throws.
 */
export async function announceReport(reportId: string): Promise<AnnounceReason | null> {
  try {
    const db = getAdminDb();
    const reportRef = db.doc(`prospectReports/${reportId}`);
    const report = (await reportRef.get()).data();
    if (
      !report ||
      report.announceProtocol !== ANNOUNCE_PROTOCOL ||
      !report.announceDueAt ||
      report.announcedAt
    ) {
      return null;
    }
    const contactRef = db.doc(`contacts/${report.contactId}`);
    const prospecting = (await contactRef.get()).data()?.prospecting;
    const record = async (reason: AnnounceReason) => {
      await reportRef.update({ announcedAt: FieldValue.serverTimestamp(), announceReason: reason });
      return reason;
    };

    // A newer report owns the contact's headline and link now.
    if (prospecting?.lastReportId !== reportId) return await record("superseded");
    // Outreach never sends a dead link.
    if (typeof report.shareId !== "string" || !prospecting?.lastReportUrl) return await record("no live link");

    await contactRef.update({ "prospecting.lastReportHeadline": report.headline ?? null });
    const outcome = await fireWorkflowTrigger({
      type: "prospecting.report.ready",
      subAccountId: report.subAccountId,
      agencyId: report.agencyId,
      contactId: report.contactId,
      context: { reportId },
      enrolmentKey: `report:${reportId}`,
    });
    if (outcome.reason === "error") {
      console.error("[prospecting/report] prospecting.report.ready trigger failed; retried later", reportId);
      return null;
    }
    return await record("fired");
  } catch (err) {
    console.error("[prospecting/report] announce failed; retried later", reportId, err);
    return null;
  }
}
