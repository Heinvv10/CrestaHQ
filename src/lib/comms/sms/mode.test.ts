import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SmsFakeRefusedError, smsProviderMode } from "./mode";

/**
 * The fake SMS provider must be impossible to reach in production. Every
 * clause is tested on its own so each one is individually load-bearing —
 * mirrors src/lib/comms/whatsapp/settings/mode.test.ts.
 */

const ORIGINAL = { ...process.env };

function fakeEnv() {
  process.env.SMS_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.SMS_FAKE_AGENCY_ID = "ag_1";
  delete process.env.SMS_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

beforeEach(fakeEnv);
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("smsProviderMode", () => {
  it("is twilio unless SMS_PROVIDER is exactly 'fake'", () => {
    for (const v of [undefined, "", "twilio", "FAKE", "fake "]) {
      if (v === undefined) delete process.env.SMS_PROVIDER;
      else process.env.SMS_PROVIDER = v;
      expect(smsProviderMode()).toBe("twilio");
    }
  });

  it("ignores the GBP/WhatsApp fakes' variables entirely", () => {
    delete process.env.SMS_PROVIDER;
    process.env.GBP_PROVIDER = "fake";
    process.env.GBP_FAKE_AGENCY_ID = "ag_1";
    process.env.WHATSAPP_SETTINGS_PROVIDER = "fake";
    process.env.WHATSAPP_FAKE_AGENCY_ID = "ag_1";
    expect(smsProviderMode()).toBe("twilio");
  });

  it("is fake with every clause satisfied", () => {
    expect(smsProviderMode()).toBe("fake");
    for (const url of ["http://localhost:3777", "http://[::1]:3100/", "http://127.1:3100"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(smsProviderMode()).toBe("fake");
    }
  });

  it("refuses a non-loopback app URL — the production URL above all — with the deploy guard's anchor message", () => {
    for (const url of ["https://crm.crestahq.com", "http://127.0.0.1.evil.example", "http://0.0.0.0:4300", "", "not a url"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(() => smsProviderMode()).toThrow(SmsFakeRefusedError);
      expect(() => smsProviderMode()).toThrow("NEXT_PUBLIC_APP_URL is not loopback (SMS fake)");
    }
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => smsProviderMode()).toThrow(SmsFakeRefusedError);
  });

  it("refuses a production build unless explicitly opted in with exactly '1'", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(() => smsProviderMode()).toThrow(SmsFakeRefusedError);
    process.env.SMS_FAKE_ALLOW_PROD_BUILD = "true";
    expect(() => smsProviderMode()).toThrow(SmsFakeRefusedError);
    process.env.GBP_FAKE_ALLOW_PROD_BUILD = "1"; // the GBP opt-in is not ours
    expect(() => smsProviderMode()).toThrow(SmsFakeRefusedError);
    process.env.SMS_FAKE_ALLOW_PROD_BUILD = "1";
    expect(smsProviderMode()).toBe("fake");
  });

  it("refuses when no fixture agency fences it", () => {
    process.env.SMS_FAKE_AGENCY_ID = "";
    expect(() => smsProviderMode()).toThrow(SmsFakeRefusedError);
    delete process.env.SMS_FAKE_AGENCY_ID;
    process.env.GBP_FAKE_AGENCY_ID = "ag_1"; // the GBP fence is not ours
    expect(() => smsProviderMode()).toThrow(SmsFakeRefusedError);
  });
});
