import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WaFakeRefusedError, whatsappSettingsProviderMode } from "./mode";

/**
 * The fake settings provider must be impossible to reach in production.
 * Every clause is tested on its own so each one is individually load-bearing.
 */

const ORIGINAL = { ...process.env };

function fakeEnv() {
  process.env.WHATSAPP_SETTINGS_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.WHATSAPP_FAKE_AGENCY_ID = "ag_1";
  delete process.env.WHATSAPP_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

beforeEach(fakeEnv);
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("whatsappSettingsProviderMode", () => {
  it("is graph unless WHATSAPP_SETTINGS_PROVIDER is exactly 'fake'", () => {
    for (const v of [undefined, "", "graph", "FAKE", "fake "]) {
      if (v === undefined) delete process.env.WHATSAPP_SETTINGS_PROVIDER;
      else process.env.WHATSAPP_SETTINGS_PROVIDER = v;
      expect(whatsappSettingsProviderMode()).toBe("graph");
    }
  });

  it("ignores the GBP fake's variables entirely", () => {
    delete process.env.WHATSAPP_SETTINGS_PROVIDER;
    process.env.GBP_PROVIDER = "fake";
    process.env.GBP_FAKE_AGENCY_ID = "ag_1";
    expect(whatsappSettingsProviderMode()).toBe("graph");
  });

  it("is fake with every clause satisfied", () => {
    expect(whatsappSettingsProviderMode()).toBe("fake");
    for (const url of ["http://localhost:3777", "http://[::1]:3100/", "http://127.1:3100"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(whatsappSettingsProviderMode()).toBe("fake");
    }
  });

  it("refuses a non-loopback app URL — the production URL above all — with the deploy guard's anchor message", () => {
    for (const url of ["https://crm.crestahq.com", "http://127.0.0.1.evil.example", "http://0.0.0.0:4300", "", "not a url"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(() => whatsappSettingsProviderMode()).toThrow(WaFakeRefusedError);
      expect(() => whatsappSettingsProviderMode()).toThrow("NEXT_PUBLIC_APP_URL is not loopback (WhatsApp fake)");
    }
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => whatsappSettingsProviderMode()).toThrow(WaFakeRefusedError);
  });

  it("refuses a production build unless explicitly opted in with exactly '1'", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(() => whatsappSettingsProviderMode()).toThrow(WaFakeRefusedError);
    process.env.WHATSAPP_FAKE_ALLOW_PROD_BUILD = "true";
    expect(() => whatsappSettingsProviderMode()).toThrow(WaFakeRefusedError);
    process.env.GBP_FAKE_ALLOW_PROD_BUILD = "1"; // the GBP opt-in is not ours
    expect(() => whatsappSettingsProviderMode()).toThrow(WaFakeRefusedError);
    process.env.WHATSAPP_FAKE_ALLOW_PROD_BUILD = "1";
    expect(whatsappSettingsProviderMode()).toBe("fake");
  });

  it("refuses when no fixture agency fences it", () => {
    process.env.WHATSAPP_FAKE_AGENCY_ID = "";
    expect(() => whatsappSettingsProviderMode()).toThrow(WaFakeRefusedError);
    delete process.env.WHATSAPP_FAKE_AGENCY_ID;
    process.env.GBP_FAKE_AGENCY_ID = "ag_1"; // the GBP fence is not ours
    expect(() => whatsappSettingsProviderMode()).toThrow(WaFakeRefusedError);
  });
});
