import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { settleApexgeo } from "./apexgeo-report";
import { APEXGEO_REASON, apexgeoPlaceholders } from "./apexgeo-sections";
import { ANNOUNCE_PROTOCOL, announceReport } from "./report-ready";

/**
 * The 15-minute announce sweep (prospect report redesign, C1 step 3). It
 * finishes what a crash left undone:
 *
 *   1. An R0-era report whose scan is still `pending` 30 minutes after it
 *      started lost its poll chain (the chain itself ends ~10 minutes in).
 *      It is settled as a timeout, which makes it final and due.
 *   2. Every R0-era report that is due and unannounced is announced
 *      (`announced` counts the ones that fired),
 *      including those step 1 just settled (the query runs after it). A
 *      server-stamped `announceDueAt` a few ms ahead of this clock is picked
 *      up by the next sweep.
 *
 * A report that keeps failing transiently is given up after
 * MAX_ANNOUNCE_ATTEMPTS (report-ready.ts), so it cannot hold a place in the
 * oldest-100 batch forever. Both queries ask for `announceProtocol == 1`: a report from before R0
 * already fired at ready and is never touched. Composite indexes for both
 * are in firestore.indexes.json.
 */

export const SWEEP_SETTLE_AFTER_MS = 30 * 60_000;
const BATCH = 100;

export async function sweepReportAnnounces(): Promise<{ settled: number; announced: number }> {
  const reports = getAdminDb().collection("prospectReports");
  const stuck = await reports
    .where("announceProtocol", "==", ANNOUNCE_PROTOCOL)
    .where("apexgeo.status", "==", "pending")
    .where("apexgeo.startedAt", "<=", new Date(Date.now() - SWEEP_SETTLE_AFTER_MS))
    .limit(BATCH)
    .get();
  let settled = 0;
  for (const doc of stuck.docs) {
    // One bad report never fails the tick; the next sweep tries it again.
    try {
      const written = await settleApexgeo(doc.id, {
        sections: apexgeoPlaceholders("timeout", APEXGEO_REASON.timeout),
        status: "timeout",
      });
      if (written) settled += 1;
    } catch (err) {
      console.error("[prospecting/announce-sweep] settle failed", doc.id, err);
    }
  }

  const due = await reports
    .where("announceProtocol", "==", ANNOUNCE_PROTOCOL)
    .where("announcedAt", "==", null)
    .where("announceDueAt", "<=", new Date())
    .limit(BATCH)
    .get();
  let announced = 0;
  for (const doc of due.docs) {
    try {
      if ((await announceReport(doc.id)) === "fired") announced += 1;
    } catch (err) {
      console.error("[prospecting/announce-sweep] announce failed", doc.id, err);
    }
  }
  return { settled, announced };
}
