import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { eventOccupiesSlot, eventStatus } from "@/types/events";
import type { CalendarEvent } from "@/types/events";
import type { BookingHost } from "@/types/booking";
import type { SubAccountMemberDoc } from "@/types/tenancy";

/**
 * Server-side helpers for booking-page hosts: resolving the host list against
 * live membership on save, host notification contacts, and the upcoming-load
 * counts round-robin assignment reads. The assignment itself is pure and
 * lives in `page-slots.ts`.
 */

/**
 * Resolve a requested host list against the sub-account's live membership:
 * keep only uids that are ACTIVE members, re-snapshot each `name` from the
 * member doc (never trust the client-supplied name), preserve request order,
 * per-host `workingHours` overrides and `priority`, and drop removed/unknown
 * members. Called from the booking-page POST/PATCH routes after shape
 * validation.
 */
export async function resolveBookingHosts(
  subAccountId: string,
  requested: BookingHost[] | undefined | null,
): Promise<BookingHost[]> {
  const reqList = requested ?? [];
  if (reqList.length === 0) return [];

  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/subAccountMembers`)
    .get();
  const activeByUid = new Map<string, SubAccountMemberDoc>();
  for (const d of snap.docs) {
    const m = d.data() as SubAccountMemberDoc;
    const uid = m.uid ?? d.id;
    if (m.status === "active") activeByUid.set(uid, m);
  }

  const out: BookingHost[] = [];
  const seen = new Set<string>();
  for (const h of reqList) {
    if (seen.has(h.uid)) continue;
    const m = activeByUid.get(h.uid);
    if (!m) continue; // dropped: no longer an active member
    seen.add(h.uid);
    const name = (m.displayName || m.email || h.name || "Host").slice(0, 120);
    const resolved: BookingHost = { uid: h.uid, name };
    // Preserve the per-host schedule override (already shape-validated by
    // validateHosts). Omit when empty so the host inherits the page hours.
    if (h.workingHours && h.workingHours.length > 0) {
      resolved.workingHours = h.workingHours;
    }
    if (h.priority) resolved.priority = h.priority;
    out.push(resolved);
  }
  return out;
}

/**
 * Resolve a host's notification contact (display name + email) from their
 * live member doc. Used to email the assigned host after a booking. Returns
 * null when the member is gone or has no email on file — the caller treats a
 * null as "skip the host notification" (never fatal to the booking).
 */
export async function loadHostNotifyContact(
  subAccountId: string,
  uid: string,
): Promise<{ name: string; email: string } | null> {
  try {
    const snap = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`)
      .get();
    if (!snap.exists) return null;
    const m = snap.data() as SubAccountMemberDoc;
    const email = (m.email ?? "").trim();
    if (!email) return null;
    return {
      name: (m.displayName || m.email || "Host").slice(0, 120),
      email,
    };
  } catch (err) {
    console.warn(`[booking/hosts] notify contact lookup failed uid=${uid}`, err);
    return null;
  }
}

/**
 * Count each host's upcoming occupying bookings — a load proxy for the
 * least-loaded tiebreak. One bounded query per host; runs BEFORE the book
 * transaction (slightly stale is fine, fairness doesn't need transactional
 * accuracy). Requires the `events(subAccountId, assignedToUid, startAt)`
 * composite index.
 */
export async function loadHostUpcomingCounts(
  subAccountId: string,
  hostUids: string[],
  now: Date,
): Promise<Map<string, number>> {
  const db = getAdminDb();
  const counts = new Map<string, number>();
  await Promise.all(
    hostUids.map(async (uid) => {
      try {
        const snap = await db
          .collection("events")
          .where("subAccountId", "==", subAccountId)
          .where("assignedToUid", "==", uid)
          .where("startAt", ">=", now)
          .get();
        let n = 0;
        for (const d of snap.docs) {
          const e = d.data() as CalendarEvent;
          if (eventOccupiesSlot(eventStatus(e))) n++;
        }
        counts.set(uid, n);
      } catch (err) {
        // Most likely the composite index isn't deployed yet — degrade to a
        // zero count so assignment still works (just not load-balanced).
        console.warn(`[booking/hosts] load count failed uid=${uid}`, err);
        counts.set(uid, 0);
      }
    }),
  );
  return counts;
}
