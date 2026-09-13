import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { sendFakeSms } from "./fake";
import { SmsFakeRefusedError, smsProviderMode } from "./mode";

export { SmsFakeRefusedError, smsProviderMode } from "./mode";

/**
 * The ONLY seam `sendSmsForSubAccount` (src/lib/comms/twilio.ts) uses to
 * actually place a send — mirrors `getGbpProviderFor` /
 * `getWhatsappSettingsProviderFor`: selection from server env alone
 * (mode.ts), never from a request value. Everything above this call
 * (quota check, credential resolution, usage recording, the
 * `SmsRecipientUnsubscribedError` mapping) is unchanged — real mode just
 * invokes `real()`, which is Twilio's own `messages.create`.
 *
 * Fake mode first asserts the sub-account belongs to SMS_FAKE_AGENCY_ID —
 * dev and CI point at the production Firestore, so the fake must never be
 * reachable for a real tenant.
 */
export async function sendSmsVia(
  subAccountId: string,
  args: { to: string; body: string },
  real: () => Promise<{ sid: string }>,
): Promise<{ sid: string }> {
  if (smsProviderMode() === "twilio") return real();
  await assertSmsFakeFixtureAgency(subAccountId);
  return sendFakeSms(args);
}

/** Throws unless SMS_FAKE_AGENCY_ID is set and `subAccountId` belongs to it. */
export async function assertSmsFakeFixtureAgency(subAccountId: string): Promise<void> {
  const fixture = process.env.SMS_FAKE_AGENCY_ID;
  if (!fixture) throw new SmsFakeRefusedError("SMS_FAKE_AGENCY_ID is not set");
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = snap.exists ? snap.data()?.agencyId : undefined;
  if (agencyId !== fixture) {
    throw new SmsFakeRefusedError("sub-account is not in the fixture agency");
  }
}
