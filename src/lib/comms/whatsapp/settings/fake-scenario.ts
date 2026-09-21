import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type {
  WaBusinessProfile,
  WaMessageLink,
  WaPhoneStatus,
  WhatsappSettingsProvider,
} from "./types";

/**
 * Scenario data for the fake settings provider. Obviously fake on purpose:
 * no real number, business or person appears here.
 */

export interface WaFakeScenario {
  phone: WaPhoneStatus;
  profile: WaBusinessProfile;
  links: WaMessageLink[];
  /** Fail the next call of `op` once with this status + message, then clear. */
  failNext?: { op: keyof WhatsappSettingsProvider; status: number; message: string };
  /** Every mutating call that reached the fake, in order — failed ones too. */
  calls: Array<{ op: string; arg?: string }>;
}

export interface WaFakeScenarioStore {
  get(subAccountId: string): Promise<WaFakeScenario | null>;
  set(subAccountId: string, scenario: WaFakeScenario): Promise<void>;
}

/** Locked path: default-deny rules already cover `private/*`. */
export function waFakeScenarioPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/whatsappFakeScenario`;
}

/** Used by the running app (local browser proof + the CI Playwright job). */
export class FirestoreWaScenarioStore implements WaFakeScenarioStore {
  async get(subAccountId: string): Promise<WaFakeScenario | null> {
    const snap = await getAdminDb().doc(waFakeScenarioPath(subAccountId)).get();
    return snap.exists ? (snap.data() as WaFakeScenario) : null;
  }

  async set(subAccountId: string, scenario: WaFakeScenario): Promise<void> {
    await getAdminDb().doc(waFakeScenarioPath(subAccountId)).set(scenario);
  }
}

/** A connected, healthy fixture number with an empty profile and no links. */
export function defaultWaFakeScenario(): WaFakeScenario {
  return {
    phone: {
      displayPhoneNumber: "+27 60 000 0000",
      verifiedName: "E2E Fixture Fibre",
      qualityRating: "GREEN",
      nameStatus: "APPROVED",
      status: "CONNECTED",
    },
    profile: {
      about: "",
      address: "",
      description: "",
      email: "",
      websites: [],
      vertical: "UNDEFINED",
      profilePictureUrl: null,
    },
    links: [],
    calls: [],
  };
}
