import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./admin";

/**
 * Fail fast, by name, if another spec left a busy event in a booking spec's
 * time windows. Hostless booking pages are blocked by ANY occupying event in
 * the sub-account, so a leak otherwise shows up as a wrong slot count that
 * reads like a product bug (it did once: another spec's "now + 2 days"
 * meetings, run in the evening, landed in the evening windows).
 *
 * `ours` recognises the calling spec's own events, which its purge handles.
 */
export async function assertWindowsClear(
  subAccountId: string,
  windows: Array<[Date, Date]>,
  ours: (e: FirebaseFirestore.DocumentData) => boolean,
): Promise<void> {
  const from = Math.min(...windows.map(([s]) => s.getTime())) - 8 * 3600_000;
  const to = Math.max(...windows.map(([, e]) => e.getTime()));
  const snap = await adminDb()
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("startAt", ">=", Timestamp.fromMillis(from))
    .where("startAt", "<", Timestamp.fromMillis(to))
    .get();
  const foreign = snap.docs
    .map((d) => d.data())
    .filter((e) => !ours(e))
    .filter((e) => e.status === undefined || e.status === "scheduled" || e.status === "awaiting_payment")
    .filter((e) => {
      const s = (e.startAt as Timestamp).toMillis();
      const en = (e.endAt as Timestamp).toMillis();
      return windows.some(([ws, we]) => s < we.getTime() && en > ws.getTime());
    });
  if (foreign.length > 0) {
    throw new Error(
      `Fixture has busy events from another spec in this spec's windows — they block hostless booking pages: ${foreign
        .map((e) => `"${e.title}" ${(e.startAt as Timestamp).toDate().toISOString()}`)
        .join(", ")}. Fix that spec's cleanup.`,
    );
  }
}
