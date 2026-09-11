import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { getWabaCreds } from "../cloud-credentials";
import { createFakeWhatsappSettingsProvider } from "./fake";
import { FirestoreWaScenarioStore } from "./fake-scenario";
import { createGraphSettingsProvider } from "./graph";
import { WaFakeRefusedError, whatsappSettingsProviderMode } from "./mode";
import type { WhatsappSettingsProvider } from "./types";

export { WaFakeRefusedError, whatsappSettingsProviderMode } from "./mode";

/**
 * The ONLY way to obtain a WhatsApp settings provider. Selection is from
 * server env alone (mode.ts) — never from a request value.
 *
 * Graph mode reads the sub-account's WABA credentials; a workspace without a
 * Cloud connection throws `WabaNotConfiguredError`, which the routes answer
 * as 409 `not_connected`. Fake mode first asserts the sub-account belongs to
 * WHATSAPP_FAKE_AGENCY_ID — dev and CI point at the production Firestore, so
 * the fake must never be obtainable for a real tenant — then returns a fake
 * bound to that one sub-account.
 */
export async function getWhatsappSettingsProviderFor(
  subAccountId: string,
): Promise<WhatsappSettingsProvider> {
  if (whatsappSettingsProviderMode() === "graph") {
    return createGraphSettingsProvider(await getWabaCreds(subAccountId));
  }
  await assertWaFakeFixtureAgency(subAccountId);
  return createFakeWhatsappSettingsProvider(new FirestoreWaScenarioStore(), subAccountId);
}

/** Throws unless WHATSAPP_FAKE_AGENCY_ID is set and `subAccountId` belongs to it. */
export async function assertWaFakeFixtureAgency(subAccountId: string): Promise<void> {
  const fixture = process.env.WHATSAPP_FAKE_AGENCY_ID;
  if (!fixture) throw new WaFakeRefusedError("WHATSAPP_FAKE_AGENCY_ID is not set");
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = snap.exists ? snap.data()?.agencyId : undefined;
  if (agencyId !== fixture) {
    throw new WaFakeRefusedError("sub-account is not in the fixture agency");
  }
}
