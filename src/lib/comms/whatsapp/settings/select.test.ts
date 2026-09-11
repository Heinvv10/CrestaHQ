import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);

import { OTHER_SUB, SUB, resetHarness, state } from "@/test/google-oauth-harness";
import { WabaNotConfiguredError } from "../cloud-credentials";
import { whatsappCloudSecretPath } from "@/types/whatsapp-cloud";
import { waFakeScenarioPath } from "./fake-scenario";
import { WaFakeRefusedError, getWhatsappSettingsProviderFor } from "./select";

/**
 * Which arm a sub-account gets, and — because dev and CI run against the
 * PRODUCTION Firestore — that the fake can never be obtained for a tenant
 * outside the fixture agency.
 */

const ORIGINAL = { ...process.env };

function fakeEnv() {
  process.env.WHATSAPP_SETTINGS_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.WHATSAPP_FAKE_AGENCY_ID = "ag_1";
  delete process.env.WHATSAPP_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

beforeEach(() => {
  resetHarness();
  fakeEnv();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("graph mode", () => {
  beforeEach(() => {
    delete process.env.WHATSAPP_SETTINGS_PROVIDER;
  });

  it("throws WabaNotConfiguredError for a sub-account with no Cloud connection", async () => {
    await expect(getWhatsappSettingsProviderFor(SUB)).rejects.toBeInstanceOf(WabaNotConfiguredError);
  });

  it("returns the Graph provider built from the sub-account's OWN secret", async () => {
    state.docs.set(whatsappCloudSecretPath(SUB), { phoneNumberId: "pn_1", wabaId: "w_1", accessToken: "tok" });
    const p = await getWhatsappSettingsProviderFor(SUB);
    expect(state.reads).toContain(whatsappCloudSecretPath(SUB));
    expect(state.reads).not.toContain(whatsappCloudSecretPath(OTHER_SUB));
    expect(typeof p.getPhoneStatus).toBe("function");
  });
});

describe("fake mode", () => {
  it("returns the fake for a sub-account of the fixture agency, bound to it", async () => {
    const p = await getWhatsappSettingsProviderFor(SUB);
    const status = await p.getPhoneStatus();
    expect(status.verifiedName).toBe("E2E Fixture Fibre");
    expect(state.reads).toContain(waFakeScenarioPath(SUB));
    expect(state.reads).not.toContain(whatsappCloudSecretPath(SUB));
  });

  it("refuses a sub-account of ANOTHER agency, and a missing one", async () => {
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client" });
    await expect(getWhatsappSettingsProviderFor(OTHER_SUB)).rejects.toBeInstanceOf(WaFakeRefusedError);
    await expect(getWhatsappSettingsProviderFor("sa_missing")).rejects.toBeInstanceOf(WaFakeRefusedError);
    expect(state.reads).not.toContain(waFakeScenarioPath(OTHER_SUB));
  });

  it("never silently falls back to Meta when fake is refused", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    state.docs.set(whatsappCloudSecretPath(SUB), { phoneNumberId: "pn_1", wabaId: "w_1", accessToken: "tok" });
    await expect(getWhatsappSettingsProviderFor(SUB)).rejects.toBeInstanceOf(WaFakeRefusedError);
    expect(state.reads).not.toContain(whatsappCloudSecretPath(SUB));
  });
});
