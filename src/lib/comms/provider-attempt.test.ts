import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 d1 — a thrown send error says whether a provider was actually called.
 * Marked where the carrier call happens, so a caller's catch can tell a
 * provider failure from a refusal before sending. This file: the marker and
 * the SMS seam. Twilio and Resend: transport-attempt.test.ts; SMTP:
 * smtp-attempt.test.ts.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import { OTHER_SUB, SUB, resetHarness, state } from "@/test/google-oauth-harness";
import { markProviderAttempted, providerAttempted } from "./provider-attempt";
import { sendSmsVia } from "./sms/select";
import { FAKE_SMS_FAIL_TO } from "./sms/fake";

const ORIGINAL = { ...process.env };
beforeEach(() => {
  resetHarness();
  process.env.SMS_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.SMS_FAKE_AGENCY_ID = "ag_1";
  (process.env as Record<string, string>).NODE_ENV = "test";
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("the marker", () => {
  it("marks an error object once, leaves it otherwise untouched, and ignores non-objects", () => {
    const err = new Error("carrier said no");
    expect(markProviderAttempted(err)).toBe(err);
    expect(providerAttempted(err)).toBe(true);
    expect(Object.keys(err)).toEqual([]);
    expect(providerAttempted(new Error("x"))).toBe(false);
    expect(providerAttempted("a string")).toBe(false);
    expect(providerAttempted(markProviderAttempted(Object.freeze(new Error("frozen"))))).toBe(false);
  });
});

describe("SMS seam", () => {
  it("the provider refusing a send is attempted", async () => {
    const err = await caught(sendSmsVia(SUB, { to: FAKE_SMS_FAIL_TO, body: "hi" }, vi.fn()));
    expect(providerAttempted(err)).toBe(true);
  });

  it("the real sender throwing is attempted", async () => {
    delete process.env.SMS_PROVIDER;
    const err = await caught(sendSmsVia(SUB, { to: "+15005550006", body: "hi" }, async () => { throw new Error("21211"); }));
    expect(providerAttempted(err)).toBe(true);
  });

  it("the fixture fence refusing is not", async () => {
    state.docs.set(`subAccounts/${OTHER_SUB}`, { agencyId: "ag_real_client" });
    const err = await caught(sendSmsVia(OTHER_SUB, { to: "+15005550006", body: "hi" }, vi.fn()));
    expect(err).toBeInstanceOf(Error);
    expect(providerAttempted(err)).toBe(false);
  });
});
