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

export type AnnounceReason = "fired" | "not enrolled" | "superseded" | "no live link" | "gave up";

/** Transient failures retried (by the next poll or sweep) before giving up. */
export const MAX_ANNOUNCE_ATTEMPTS = 8;

/**
 * Announce one report if it is due. Returns what it recorded, or null when
 * the report was not due or the attempt failed transiently (the next caller
 * retries). Never throws.
 *
 * Recorded outcomes are final:
 *   - "fired": at least one workflow enrolled, now or (a re-fire after a
 *     crash, refused by its enrolment key) on an earlier attempt;
 *   - "not enrolled": the trigger ran and no workflow took the contact (a
 *     once_ever workflow, unmet filters, none active, automations paused).
 *     The owner's configuration said no; retrying could one day message
 *     someone they chose not to. The reasons are kept in `announceSkips`;
 *   - "superseded" / "no live link": nothing fired (see above);
 *   - "gave up": MAX_ANNOUNCE_ATTEMPTS transient failures in a row.
 * A transient failure (the trigger errored, or a workflow's re-entry
 * transaction failed) records nothing but `announceAttempts`.
 */
export async function announceReport(reportId: string): Promise<AnnounceReason | null> {
  const db = getAdminDb();
  const reportRef = db.doc(`prospectReports/${reportId}`);
  const recorded = (reason: AnnounceReason, extra: Record<string, unknown> = {}) => ({
    announcedAt: FieldValue.serverTimestamp(),
    announceReason: reason,
    ...extra,
  });
  try {
    // One transaction decides: the superseded check and the headline stamp
    // cannot straddle a newer report taking the contact.
    const decided = await db.runTransaction(async (tx) => {
      const report = (await tx.get(reportRef)).data();
      if (
        !report ||
        report.announceProtocol !== ANNOUNCE_PROTOCOL ||
        !report.announceDueAt ||
        report.announcedAt
      ) {
        return null;
      }
      const contactRef = db.doc(`contacts/${report.contactId}`);
      const contact = (await tx.get(contactRef)).data();
      const prospecting = contact?.prospecting;
      // A newer report owns the contact's headline and link now.
      if (prospecting?.lastReportId !== reportId) {
        tx.update(reportRef, recorded("superseded"));
        return "superseded" as const;
      }
      // Outreach never sends a dead link.
      if (typeof report.shareId !== "string" || !prospecting?.lastReportUrl) {
        tx.update(reportRef, recorded("no live link"));
        return "no live link" as const;
      }
      tx.update(contactRef, { "prospecting.lastReportHeadline": report.headline ?? null });
      return { report };
    });
    if (decided === null || typeof decided === "string") return decided;

    const { report } = decided;
    const enrolmentKey = `report:${reportId}`;
    const outcome = await fireWorkflowTrigger({
      type: "prospecting.report.ready",
      subAccountId: report.subAccountId,
      agencyId: report.agencyId,
      contactId: report.contactId,
      context: { reportId },
      enrolmentKey,
    });
    if (outcome.reason === "error" || outcome.skipped.some((s) => s.reason === "reentry_check_failed")) {
      console.error("[prospecting/report] prospecting.report.ready trigger failed; retried later", reportId);
      return await retryLater(reportRef, reportId);
    }
    // A re-fire after a crash is refused by the key an earlier fire wrote:
    // that is this report's own enrolment, so it did fire.
    const keyed = await Promise.all(
      outcome.skipped
        .filter((s) => s.reason === "reentry_blocked")
        .map((s) => db.doc(`workflowEnrolmentKeys/${s.workflowId}_${report.contactId}_${enrolmentKey}`).get()),
    );
    if (outcome.enrolled.length === 0 && !keyed.some((k) => k.exists)) {
      const skips: Array<{ workflowId: string | null; reason: string }> = outcome.skipped.map((s) => ({ ...s }));
      if (outcome.reason) skips.push({ workflowId: null, reason: outcome.reason });
      await reportRef.update(recorded("not enrolled", { announceSkips: skips }));
      return "not enrolled";
    }
    await reportRef.update(recorded("fired"));
    return "fired";
  } catch (err) {
    console.error("[prospecting/report] announce failed; retried later", reportId, err);
    return retryLater(reportRef, reportId).catch((e) => {
      console.error("[prospecting/report] announce attempt not counted", reportId, e);
      return null;
    });
  }
}

/** Count a transient failure; the last allowed one records "gave up". */
async function retryLater(
  reportRef: FirebaseFirestore.DocumentReference,
  reportId: string,
): Promise<"gave up" | null> {
  return getAdminDb().runTransaction(async (tx) => {
    const report = (await tx.get(reportRef)).data();
    // Only a report the announce acts on: a failure before it is due must
    // never run down its attempts.
    if (
      !report ||
      report.announceProtocol !== ANNOUNCE_PROTOCOL ||
      !report.announceDueAt ||
      report.announcedAt
    ) {
      return null;
    }
    const attempts = ((report.announceAttempts as number | undefined) ?? 0) + 1;
    if (attempts < MAX_ANNOUNCE_ATTEMPTS) {
      tx.update(reportRef, { announceAttempts: attempts });
      return null;
    }
    console.error("[prospecting/report] announce gave up after repeated failures", reportId, attempts);
    tx.update(reportRef, {
      announceAttempts: attempts,
      announcedAt: FieldValue.serverTimestamp(),
      announceReason: "gave up",
    });
    return "gave up" as const;
  });
}
