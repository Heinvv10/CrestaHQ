import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the outbound-calling compliance gate — identity,
 * opt-out, consent, quota, country allow-list, the scrub provider, and check
 * ORDER. The timezone window and the frequency caps are in
 * `outbound-compliance-window.test.ts`; both share the doubles in
 * `src/test/voice-compliance-harness.ts`.
 *
 * Every branch here is a "never place this call" invariant. The gate runs
 * BEFORE any Vapi spend, so a blocked call must also cost nothing — several
 * tests assert the external scrub was never even consulted.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const h = await import("@/test/voice-compliance-harness");
  return { getAdminDb: () => h.fakeDb() };
});

vi.mock("@/lib/server/usage-meter", async () => {
  const h = await import("@/test/voice-compliance-harness");
  return { checkQuota: (...a: unknown[]) => h.checkQuota(...(a as [])) };
});

vi.mock("./compliance-provider", async () => {
  const h = await import("@/test/voice-compliance-harness");
  return { getComplianceProvider: () => ({ scrub: h.scrub }) };
});

import {
  AU_PHONE,
  US_PHONE,
  checkQuota,
  contact,
  gateInput,
  resetHarness,
  scrub,
  voice,
  type RunOverrides,
} from "@/test/voice-compliance-harness";
import { checkOutboundCompliance, validDialNumber } from "./outbound-compliance";

function run(over: RunOverrides = {}) {
  return checkOutboundCompliance(gateInput(over));
}

beforeEach(resetHarness);

// ---- the allowed baseline --------------------------------------------

describe("the happy baseline", () => {
  it("allows a valid, consented, non-opted-out contact and returns E.164", async () => {
    const res = await run();
    expect(res.allowed).toBe(true);
    expect(res.e164).toBe(AU_PHONE);
    expect(res.code).toBeUndefined();
  });
});

// ---- 1. phone --------------------------------------------------------

describe("phone validity", () => {
  it("blocks with no_phone when the contact has no number", async () => {
    const res = await run({ contact: contact({ phone: "" }) });
    expect(res).toMatchObject({ allowed: false, code: "no_phone" });
  });

  it("blocks with no_phone when the number isn't valid E.164", async () => {
    const res = await run({
      contact: contact({ phone: "call the front desk" }),
    });
    expect(res).toMatchObject({ allowed: false, code: "no_phone" });
  });

  it("normalises a valid national-format number to E.164", async () => {
    const res = await run({ contact: contact({ phone: "+61 412 345 678" }) });
    expect(res.allowed).toBe(true);
    expect(res.e164).toBe(AU_PHONE);
  });
});

// ---- 2. voice opt-out ------------------------------------------------

describe("voice opt-out", () => {
  it("blocks a contact with voiceOptedOut === true", async () => {
    const res = await run({ contact: contact({ voiceOptedOut: true }) });
    expect(res).toMatchObject({ allowed: false, code: "opted_out" });
  });

  it("does NOT block on smsOptedOut — the flags are independent", async () => {
    const res = await run({
      contact: contact({ smsOptedOut: true, voiceOptedOut: false }),
    });
    expect(res.allowed).toBe(true);
  });

  it("does NOT block on emailOptedOut either", async () => {
    const res = await run({ contact: contact({ emailOptedOut: true }) });
    expect(res.allowed).toBe(true);
  });

  it("blocks on voiceOptedOut even when smsOptedOut is false", async () => {
    const res = await run({
      contact: contact({ smsOptedOut: false, voiceOptedOut: true }),
    });
    expect(res).toMatchObject({ allowed: false, code: "opted_out" });
  });
});

// ---- 3. consent ------------------------------------------------------

describe("per-call consent acknowledgment", () => {
  it("blocks when consentAck is false", async () => {
    const res = await run({ consentAck: false });
    expect(res).toMatchObject({ allowed: false, code: "no_consent" });
  });

  it("requires a literal true — a truthy non-boolean does not pass", async () => {
    const res = await checkOutboundCompliance({
      ...gateInput(),
      consentAck: "yes" as unknown as boolean,
    });
    expect(res).toMatchObject({ allowed: false, code: "no_consent" });
  });
});

// ---- 3b. quota -------------------------------------------------------

describe("monthly voice-minutes quota", () => {
  it("blocks with quota when the workspace is over its limit", async () => {
    checkQuota.mockResolvedValue({ allowed: false });
    const res = await run();
    expect(res).toMatchObject({ allowed: false, code: "quota" });
  });

  it("asks the meter about voiceSeconds for this sub-account", async () => {
    await run({ subAccountId: "sa_quota_probe" });
    expect(checkQuota).toHaveBeenCalledWith({
      subAccountId: "sa_quota_probe",
      unit: "voiceSeconds",
    });
  });
});

// ---- 4. country allow-list -------------------------------------------

describe("country allow-list", () => {
  it("null means allow-all, NOT deny-all", async () => {
    const res = await run({ voice: voice({ allowedCountries: null }) });
    expect(res.allowed).toBe(true);
  });

  it("an empty list also means allow-all (no accidental global block)", async () => {
    const res = await run({ voice: voice({ allowedCountries: [] }) });
    expect(res.allowed).toBe(true);
  });

  it("blocks a number whose country isn't on a non-empty list", async () => {
    const res = await run({
      contact: contact({ phone: US_PHONE }),
      voice: voice({ allowedCountries: ["AU", "NZ"] }),
    });
    expect(res).toMatchObject({ allowed: false, code: "country_blocked" });
    expect(res.reason).toContain("US");
  });

  it("allows a number whose country IS on the list", async () => {
    const res = await run({ voice: voice({ allowedCountries: ["AU"] }) });
    expect(res.allowed).toBe(true);
  });
});

// ---- 8. pluggable scrub provider -------------------------------------

describe("third-party scrub provider", () => {
  it("blocks and surfaces the provider's reasons", async () => {
    scrub.mockResolvedValue({
      allowed: false,
      reasons: ["on the DNC register"],
    });
    const res = await run();
    expect(res).toMatchObject({ allowed: false, code: "scrub_blocked" });
    expect(res.reason).toContain("DNC");
  });

  it("allows when the provider throws (outage must not halt all calling)", async () => {
    scrub.mockRejectedValue(new Error("vendor down"));
    const res = await run();
    expect(res.allowed).toBe(true);
  });

  it("screens the normalised E.164, not the raw typed string", async () => {
    await run({ contact: contact({ phone: "+61 412 345 678" }) });
    expect(scrub).toHaveBeenCalledWith(AU_PHONE);
  });
});

// ---- ordering: first failing check wins -------------------------------

describe("check ordering — the first failing check wins", () => {
  it("no_phone beats opted_out", async () => {
    const res = await run({
      contact: contact({ phone: "nonsense", voiceOptedOut: true }),
    });
    expect(res.code).toBe("no_phone");
  });

  it("opted_out beats no_consent", async () => {
    const res = await run({
      contact: contact({ voiceOptedOut: true }),
      consentAck: false,
    });
    expect(res.code).toBe("opted_out");
  });

  it("opted_out beats the country block", async () => {
    const res = await run({
      contact: contact({ phone: US_PHONE, voiceOptedOut: true }),
      voice: voice({ allowedCountries: ["AU"] }),
    });
    expect(res.code).toBe("opted_out");
  });

  it("no_consent beats the quota check (no meter read for an unconsented call)", async () => {
    checkQuota.mockResolvedValue({ allowed: false });
    checkQuota.mockClear();
    const res = await run({ consentAck: false });
    expect(res.code).toBe("no_consent");
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it("every blocking check runs BEFORE the scrub provider is consulted", async () => {
    // Blocked calls must cost nothing — not even an external screening call.
    scrub.mockClear();
    await run({ contact: contact({ voiceOptedOut: true }) });
    await run({ consentAck: false });
    await run({ contact: contact({ phone: "junk" }) });
    expect(scrub).not.toHaveBeenCalled();
  });
});

// ---- the dialer's additions leave this gate alone ---------------------

describe("validDialNumber — the AI gate's parse is unchanged", () => {
  it("a number without \"+\" is invalid — there is no default region", () => {
    expect(validDialNumber("082 123 4567")).toBeNull();
    expect(validDialNumber("27821234567")).toBeNull();
    expect(validDialNumber("+27 82 123 4567")).toEqual({ e164: "+27821234567", country: "ZA", national: "821234567" });
  });

  it("a non-geographic number is still a valid number here (the dialer alone refuses it)", async () => {
    expect(validDialNumber("+88216000000")).toMatchObject({ e164: "+88216000000", country: null });
    const res = await run({ contact: contact({ phone: "+88216000000" }) });
    expect(res.code).not.toBe("no_phone");
  });
});
