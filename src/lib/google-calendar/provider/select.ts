import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createFakeGcalProvider, FirestoreFakeCalendarStore } from "./fake";
import { googleGcalProvider } from "./google";
import { GcalFakeRefusedError, gcalProviderMode } from "./mode";
import type { GcalProvider } from "./types";

/**
 * The ONLY way to obtain a Google Calendar provider. Selection is from server
 * env alone (mode.ts) — never from a request value. In fake mode the
 * sub-account must belong to GCAL_FAKE_AGENCY_ID (dev and CI run against the
 * production Firestore), and the fake is BOUND to (subAccountId, uid) so it
 * only ever touches that member's fake calendar.
 */
export async function getGcalProviderFor(
  subAccountId: string,
  uid: string,
): Promise<GcalProvider> {
  if (gcalProviderMode() === "google") return googleGcalProvider;
  await assertGcalFakeFixtureAgency(subAccountId);
  return createFakeGcalProvider(new FirestoreFakeCalendarStore(), { subAccountId, uid });
}

/** Throws unless GCAL_FAKE_AGENCY_ID is set and `subAccountId` belongs to it. */
export async function assertGcalFakeFixtureAgency(subAccountId: string): Promise<void> {
  const fixture = process.env.GCAL_FAKE_AGENCY_ID;
  if (!fixture) throw new GcalFakeRefusedError("GCAL_FAKE_AGENCY_ID is not set");
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = snap.exists ? snap.data()?.agencyId : undefined;
  if (agencyId !== fixture) {
    throw new GcalFakeRefusedError("sub-account is not in the fixture agency");
  }
}
