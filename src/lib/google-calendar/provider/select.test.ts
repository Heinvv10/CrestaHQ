import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import { OTHER_SUB, SUB, resetHarness, state } from "@/test/google-oauth-harness";
import { GcalFakeRefusedError, gcalAppConfigured, gcalFakeAllowed, gcalProviderMode } from "./mode";
import { assertGcalFakeFixtureAgency, getGcalProviderFor } from "./select";
import { googleGcalProvider } from "./google";

/**
 * The Google Calendar fake must be impossible to reach in production and —
 * dev and CI run against the PRODUCTION Firestore — impossible to aim at a
 * real tenant. One test per clause, each individually load-bearing.
 */

const ORIGINAL = { ...process.env };

function fakeEnv() {
  process.env.GCAL_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.GCAL_FAKE_AGENCY_ID = "ag_1";
  delete process.env.GCAL_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

beforeEach(() => {
  resetHarness();
  fakeEnv();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("gcalProviderMode", () => {
  it("is google unless GCAL_PROVIDER is exactly 'fake'", () => {
    for (const v of [undefined, "", "google", "FAKE", "fake "]) {
      if (v === undefined) delete process.env.GCAL_PROVIDER;
      else process.env.GCAL_PROVIDER = v;
      expect(gcalProviderMode()).toBe("google");
    }
  });

  it("is fake with every clause satisfied, on each loopback host", () => {
    for (const url of ["http://127.0.0.1:3100", "http://localhost:3777", "http://[::1]:3100/"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(gcalProviderMode()).toBe("fake");
    }
  });

  it("refuses a non-loopback app URL, with the message the deploy guard anchors on", () => {
    for (const url of ["https://crm.crestahq.com", "http://0.0.0.0:3100", "http://127.0.0.2", "http://x.localhost", "", "not a url"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(() => gcalProviderMode()).toThrow("NEXT_PUBLIC_APP_URL is not loopback (Google Calendar fake)");
    }
  });

  it("refuses a production build unless GCAL_FAKE_ALLOW_PROD_BUILD is exactly '1'", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    for (const v of [undefined, "", "true", "yes", "0"]) {
      if (v === undefined) delete process.env.GCAL_FAKE_ALLOW_PROD_BUILD;
      else process.env.GCAL_FAKE_ALLOW_PROD_BUILD = v;
      expect(() => gcalProviderMode()).toThrow(GcalFakeRefusedError);
    }
    process.env.GCAL_FAKE_ALLOW_PROD_BUILD = "1";
    expect(gcalProviderMode()).toBe("fake");
  });

  it("refuses without GCAL_FAKE_AGENCY_ID", () => {
    delete process.env.GCAL_FAKE_AGENCY_ID;
    expect(() => gcalProviderMode()).toThrow("GCAL_FAKE_AGENCY_ID is not set");
  });

  it("a refused fake is 'not configured', never a silent fall-back to Google", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    expect(gcalFakeAllowed()).toBe(false);
    expect(gcalAppConfigured()).toBe(false);
  });
});

describe("getGcalProviderFor / the fixture-agency fence", () => {
  it("returns the real provider in google mode", async () => {
    delete process.env.GCAL_PROVIDER;
    expect(await getGcalProviderFor(SUB, "uid_a")).toBe(googleGcalProvider);
  });

  it("returns a fake for a fixture-agency sub-account", async () => {
    const p = await getGcalProviderFor(SUB, "uid_a");
    expect(p).not.toBe(googleGcalProvider);
    expect(p.authorizeUrl({ redirectUri: "http://127.0.0.1:3100/api/google/callback", state: "s" })).toContain(
      `code=fake-gcal-code%3A${SUB}%3Auid_a`,
    );
  });

  it("refuses a sub-account of another agency — the provider AND the assert helper", async () => {
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client" });
    await expect(getGcalProviderFor(OTHER_SUB, "uid_a")).rejects.toThrow("not in the fixture agency");
    await expect(assertGcalFakeFixtureAgency(OTHER_SUB)).rejects.toThrow(GcalFakeRefusedError);
    await expect(assertGcalFakeFixtureAgency("missing_sa")).rejects.toThrow(GcalFakeRefusedError);
    await expect(assertGcalFakeFixtureAgency(SUB)).resolves.toBeUndefined();
  });

  it("the assert helper refuses without GCAL_FAKE_AGENCY_ID", async () => {
    delete process.env.GCAL_FAKE_AGENCY_ID;
    await expect(assertGcalFakeFixtureAgency(SUB)).rejects.toThrow("GCAL_FAKE_AGENCY_ID is not set");
  });
});
