import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The time- and volume-based half of the outbound compliance gate: the
 * calling window (evaluated in the CONTACT's timezone, not the server's), the
 * durable daily + per-number frequency caps, and the in-memory per-minute
 * burst limiter. Identity/consent/country/scrub live in
 * `outbound-compliance.test.ts`; both share the doubles in
 * `src/test/voice-compliance-harness.ts`.
 *
 * The timezone table and window math are the REAL implementations — stubbing
 * them would make these assertions meaningless.
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
  contact,
  gateInput,
  resetHarness,
  setFirestoreThrows,
  setVoiceCallDocs,
  voice,
  type RunOverrides,
} from "@/test/voice-compliance-harness";
import { checkOutboundCompliance } from "./outbound-compliance";

function run(over: RunOverrides = {}) {
  return checkOutboundCompliance(gateInput(over));
}

beforeEach(resetHarness);
afterEach(() => {
  vi.useRealTimers();
});

// ---- 5. calling window (contact's timezone) --------------------------

describe("calling window — evaluated in the CONTACT's timezone", () => {
  // 2026-01-15T02:00:00Z is 13:00 in Sydney (UTC+11, AEDT) and 20:00 the
  // previous evening in Chicago (UTC-6, CST). One window, two verdicts —
  // which is only possible if the contact's own zone drives the check.
  const INSTANT = new Date("2026-01-15T02:00:00Z");
  const NINE_TO_FIVE = { startHour: 9, endHour: 17, timezone: "UTC" };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(INSTANT);
  });

  it("allows an AU number at 13:00 Sydney", async () => {
    const res = await run({
      contact: contact({ phone: AU_PHONE }),
      voice: voice({ outboundWindow: NINE_TO_FIVE }),
    });
    expect(res.allowed).toBe(true);
  });

  it("blocks a US number at the SAME instant (20:00 Chicago) and says so", async () => {
    const res = await run({
      contact: contact({ phone: US_PHONE }),
      voice: voice({ outboundWindow: NINE_TO_FIVE }),
    });
    expect(res).toMatchObject({ allowed: false, code: "outside_window" });
    expect(res.reason).toContain("America/Chicago");
    expect(res.retryAfterSec).toBeGreaterThan(0);
  });

  it("defers rather than dropping — retryAfterSec points at the next window", async () => {
    const res = await run({
      contact: contact({ phone: US_PHONE }),
      voice: voice({ outboundWindow: NINE_TO_FIVE }),
    });
    // 20:00 Chicago → next 09:00 is 13h away.
    expect(res.retryAfterSec).toBeCloseTo(13 * 3600, -2);
  });

  it("a null window means no window restriction", async () => {
    const res = await run({
      contact: contact({ phone: US_PHONE }),
      voice: voice({ outboundWindow: null }),
    });
    expect(res.allowed).toBe(true);
  });

  it("falls back to the agent timezone when the number's country isn't in the tz table", () => {
    // Greenland (+299) parses fine but isn't in COUNTRY_TZ, and the window
    // carries no timezone of its own — so agentTimezone decides. At the fixed
    // instant it's 13:00 in Sydney (inside) but 02:00 UTC (outside).
    const gl = contact({ phone: "+299321000" });
    const noTz = { startHour: 9, endHour: 17, timezone: "" };
    return Promise.all([
      run({
        contact: gl,
        agentTimezone: "Australia/Sydney",
        voice: voice({ outboundWindow: noTz }),
      }),
      run({
        contact: gl,
        agentTimezone: "UTC",
        voice: voice({ outboundWindow: noTz }),
      }),
    ]).then(([inside, outside]) => {
      expect(inside.allowed).toBe(true);
      expect(outside).toMatchObject({ allowed: false, code: "outside_window" });
    });
  });
});

// ---- 6. daily cap + per-number frequency ------------------------------

describe("daily cap + per-number frequency (durable, Firestore)", () => {
  it("blocks once the 24h outbound count reaches the daily cap", async () => {
    setVoiceCallDocs([
      { callerPhone: "+61400000001" },
      { callerPhone: "+61400000002" },
    ]);
    const res = await run({ voice: voice({ outboundDailyCap: 2 }) });
    expect(res).toMatchObject({ allowed: false, code: "daily_cap" });
  });

  it("allows while strictly under the daily cap", async () => {
    setVoiceCallDocs([{ callerPhone: "+61400000001" }]);
    const res = await run({ voice: voice({ outboundDailyCap: 2 }) });
    expect(res.allowed).toBe(true);
  });

  it("blocks when THIS number has hit its per-day frequency cap", async () => {
    setVoiceCallDocs([
      { callerPhone: AU_PHONE },
      { callerPhone: "+61400000009" },
    ]);
    const res = await run({
      voice: voice({ outboundDailyCap: 100, outboundPerNumberPerDay: 1 }),
    });
    expect(res).toMatchObject({ allowed: false, code: "number_frequency" });
  });

  it("counts only calls to the SAME number for the frequency cap", async () => {
    setVoiceCallDocs([
      { callerPhone: "+61400000009" },
      { callerPhone: "+61400000008" },
    ]);
    const res = await run({
      voice: voice({ outboundDailyCap: 100, outboundPerNumberPerDay: 1 }),
    });
    expect(res.allowed).toBe(true);
  });

  it("fails OPEN on a Firestore error (documented trade-off)", async () => {
    setFirestoreThrows(true);
    const res = await run({ voice: voice({ outboundDailyCap: 0 }) });
    expect(res.allowed).toBe(true);
  });

  it("opted_out beats the daily cap", async () => {
    setVoiceCallDocs([{ callerPhone: "x" }]);
    const res = await run({
      contact: contact({ voiceOptedOut: true }),
      voice: voice({ outboundDailyCap: 1 }),
    });
    expect(res.code).toBe("opted_out");
  });
});

// ---- 7. per-minute burst limiter -------------------------------------

describe("per-minute burst limiter", () => {
  it("blocks the call that exceeds the per-minute cap for that sub-account", async () => {
    const sa = "sa_burst_a";
    const v = voice({ outboundPerMinuteCap: 1 });
    const first = await run({ subAccountId: sa, voice: v });
    const second = await run({ subAccountId: sa, voice: v });
    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({
      allowed: false,
      code: "rate_limited",
      retryAfterSec: 60,
    });
  });

  it("is scoped per sub-account — one tenant can't exhaust another's slots", async () => {
    const v = voice({ outboundPerMinuteCap: 1 });
    await run({ subAccountId: "sa_burst_b", voice: v });
    const other = await run({ subAccountId: "sa_burst_c", voice: v });
    expect(other.allowed).toBe(true);
  });

  it("does not consume a slot when an earlier check already blocked", async () => {
    const sa = "sa_burst_d";
    const v = voice({ outboundPerMinuteCap: 1 });
    // Blocked on consent — must not burn the single slot...
    await run({ subAccountId: sa, voice: v, consentAck: false });
    // ...so a legitimate call still gets through.
    const ok = await run({ subAccountId: sa, voice: v });
    expect(ok.allowed).toBe(true);
  });
});
