import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Agency gate for per-member Google Calendar sync. Opt-in like every gate:
 * legacy/unset reads as off. The Manage-dialog checkbox flips
 * `googleCalendarEnabledByAgency` via /api/agency/sub-accounts/[id]/feature-gates.
 * While off: the card is hidden, connect refuses, Google busy is not read and
 * bookings are not pushed. Disconnect — and removing events LeadStack already
 * wrote — stay available.
 */
export async function googleCalendarGateOn(subAccountId: string): Promise<boolean> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.data()?.googleCalendarEnabledByAgency === true;
}
