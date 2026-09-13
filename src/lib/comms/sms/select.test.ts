import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);

import { OTHER_SUB, SUB, resetHarness, state } from "@/test/google-oauth-harness";
import { SmsFakeRefusedError, sendSmsVia } from "./select";
import { FAKE_SMS_FAIL_TO } from "./fake";

/**
 * Which arm a sub-account gets, and — because dev and CI run against the
 * PRODUCTION Firestore — that the fake can never be reached for a tenant
 * outside the fixture agency. Mirrors
 * src/lib/comms/whatsapp/settings/select.test.ts.
 */

const ORIGINAL = { ...process.env };

function fakeEnv() {
  process.env.SMS_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.SMS_FAKE_AGENCY_ID = "ag_1";
  delete process.env.SMS_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

beforeEach(() => {
  resetHarness();
  fakeEnv();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("twilio mode", () => {
  beforeEach(() => {
    delete process.env.SMS_PROVIDER;
  });

  it("calls the real sender and never the fake", async () => {
    const real = vi.fn(async () => ({ sid: "SM_real_1" }));
    const result = await sendSmsVia(SUB, { to: "+15005550006", body: "hi" }, real);
    expect(result).toEqual({ sid: "SM_real_1" });
    expect(real).toHaveBeenCalledTimes(1);
  });
});

describe("fake mode", () => {
  it("returns a deterministic fake sid for a sub-account of the fixture agency, never calling real()", async () => {
    const real = vi.fn(async () => ({ sid: "SM_real_1" }));
    const result = await sendSmsVia(SUB, { to: "+15005550006", body: "hi" }, real);
    expect(result.sid).toMatch(/^SMfake\d{8}$/);
    expect(real).not.toHaveBeenCalled();
    expect(state.reads).toContain(`subAccounts/${SUB}`);
  });

  it("throws for the magic failing number, and records nothing else", async () => {
    const real = vi.fn(async () => ({ sid: "SM_real_1" }));
    await expect(
      sendSmsVia(SUB, { to: FAKE_SMS_FAIL_TO, body: "hi" }, real),
    ).rejects.toThrow(/magic failing number/);
    expect(real).not.toHaveBeenCalled();
  });

  it("refuses a sub-account of ANOTHER agency, and a missing one", async () => {
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client" });
    const real = vi.fn(async () => ({ sid: "SM_real_1" }));
    await expect(sendSmsVia(OTHER_SUB, { to: "x", body: "y" }, real)).rejects.toBeInstanceOf(
      SmsFakeRefusedError,
    );
    await expect(sendSmsVia("sa_missing", { to: "x", body: "y" }, real)).rejects.toBeInstanceOf(
      SmsFakeRefusedError,
    );
    expect(real).not.toHaveBeenCalled();
  });

  it("never silently falls back to Twilio when the fake is refused", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    const real = vi.fn(async () => ({ sid: "SM_real_1" }));
    await expect(sendSmsVia(SUB, { to: "x", body: "y" }, real)).rejects.toBeInstanceOf(
      SmsFakeRefusedError,
    );
    expect(real).not.toHaveBeenCalled();
  });
});
