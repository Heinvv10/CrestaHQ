import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);

import { resetHarness, state, SUB, OTHER_SUB } from "@/test/google-oauth-harness";
import { GbpFakeRefusedError, gbpProviderMode, getGbpProviderFor } from "./select";
import { googleGbpProvider } from "./google";

/**
 * The fake provider must be impossible to reach in production, and — because
 * local dev and CI both run against the PRODUCTION Firestore — impossible to
 * aim at a real tenant. Every clause is tested on its own so each one is
 * individually load-bearing (and individually mutation-proven).
 */

const ORIGINAL = { ...process.env };

function fakeEnv() {
  process.env.GBP_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.GBP_FAKE_AGENCY_ID = "ag_1";
  delete process.env.GBP_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

beforeEach(() => {
  resetHarness();
  fakeEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("gbpProviderMode", () => {
  it("is google unless GBP_PROVIDER is exactly 'fake'", () => {
    for (const v of [undefined, "", "google", "FAKE", "fake "]) {
      if (v === undefined) delete process.env.GBP_PROVIDER;
      else process.env.GBP_PROVIDER = v;
      expect(gbpProviderMode()).toBe("google");
    }
  });

  it("is fake with every clause satisfied", () => {
    expect(gbpProviderMode()).toBe("fake");
    for (const url of ["http://localhost:3777", "http://[::1]:3100/"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(gbpProviderMode()).toBe("fake");
    }
  });

  it("refuses a non-loopback app URL — the production URL above all", () => {
    for (const url of ["https://crm.crestahq.com", "http://127.0.0.1.evil.example", "", "not a url"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(() => gbpProviderMode()).toThrow(GbpFakeRefusedError);
    }
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => gbpProviderMode()).toThrow(GbpFakeRefusedError);
  });

  it("refuses a production build unless explicitly opted in with exactly '1'", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(() => gbpProviderMode()).toThrow(GbpFakeRefusedError);
    process.env.GBP_FAKE_ALLOW_PROD_BUILD = "true";
    expect(() => gbpProviderMode()).toThrow(GbpFakeRefusedError);
    process.env.GBP_FAKE_ALLOW_PROD_BUILD = "1";
    expect(gbpProviderMode()).toBe("fake");
  });

  it("refuses when no fixture agency fences it", () => {
    process.env.GBP_FAKE_AGENCY_ID = "";
    expect(() => gbpProviderMode()).toThrow(GbpFakeRefusedError);
    delete process.env.GBP_FAKE_AGENCY_ID;
    expect(() => gbpProviderMode()).toThrow(GbpFakeRefusedError);
  });
});

describe("getGbpProviderFor", () => {
  it("returns the real Google provider in google mode", async () => {
    delete process.env.GBP_PROVIDER;
    expect(await getGbpProviderFor(SUB)).toBe(googleGbpProvider);
  });

  it("returns the fake for a sub-account of the fixture agency", async () => {
    const p = await getGbpProviderFor(SUB);
    expect(p).not.toBe(googleGbpProvider);
    expect(p.authorizeUrl({ redirectUri: "http://127.0.0.1:3100/cb", state: "s" })).toContain(
      `code=fake-code%3A${SUB}`,
    );
  });

  it("refuses a sub-account of ANOTHER agency, and a missing one", async () => {
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client" });
    await expect(getGbpProviderFor(OTHER_SUB)).rejects.toBeInstanceOf(GbpFakeRefusedError);
    await expect(getGbpProviderFor("sa_missing")).rejects.toBeInstanceOf(GbpFakeRefusedError);
  });

  it("never silently falls back to Google when fake is refused", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    await expect(getGbpProviderFor(SUB)).rejects.toBeInstanceOf(GbpFakeRefusedError);
  });
});

describe("loopback semantics shared with the deploy guard", () => {
  it.each(["http://127.1:3100", "http://0x7f000001:3100", "HTTP://LOCALHOST:3100", "http://[0:0:0:0:0:0:0:1]:3100"])(
    "treats %s as loopback (WHATWG-normalised)",
    (url) => {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(gbpProviderMode()).toBe("fake");
    },
  );
});
