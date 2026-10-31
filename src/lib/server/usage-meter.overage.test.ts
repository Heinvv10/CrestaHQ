import { describe, expect, it, vi } from "vitest";

/**
 * computeOverage — the overage preview's maths. Money is integer minor
 * units; each unit's line rounds half-up once and the total is the sum of
 * the rounded lines. Pure function, real production code.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { computeOverage, sanitizeUsageRates, MAX_USAGE_RATE_CENTS } = await import("./usage-meter");

describe("computeOverage", () => {
  it("bills nothing at exactly the included allowance, one unit at one past it", () => {
    const quotas = { emailsPerMonth: 100 };
    const rates = { emailCents: 7 };
    expect(computeOverage({ emailsSent: 100 }, quotas, rates)).toEqual({ perUnit: {}, totalCents: 0 });
    expect(computeOverage({ emailsSent: 101 }, quotas, rates)).toEqual({
      perUnit: { emailsSent: { overUnits: 1, cents: 7 } },
      totalCents: 7,
    });
  });

  it("voice: the allowance is minutes, the ledger seconds", () => {
    const quotas = { voiceMinutesPerMonth: 10 };
    const rates = { voiceMinuteCents: 60 };
    expect(computeOverage({ voiceSeconds: 600 }, quotas, rates).totalCents).toBe(0);
    // One second over at 60c a minute is exactly 1c.
    expect(computeOverage({ voiceSeconds: 601 }, quotas, rates)).toEqual({
      perUnit: { voiceSeconds: { overUnits: 1, cents: 1 } },
      totalCents: 1,
    });
  });

  it("zero usage, no quotas, no rates, a zero rate or an unlimited unit all bill nothing", () => {
    const quotas = { emailsPerMonth: 10, smsSegmentsPerMonth: 10 };
    expect(computeOverage({}, quotas, { emailCents: 5 }).totalCents).toBe(0);
    expect(computeOverage({ emailsSent: 50 }, null, { emailCents: 5 }).totalCents).toBe(0);
    expect(computeOverage({ emailsSent: 50 }, quotas, null).totalCents).toBe(0);
    expect(computeOverage({ emailsSent: 50 }, quotas, { emailCents: 0 }).totalCents).toBe(0);
    // A rate that rounds to zero minor units is no rate.
    expect(computeOverage({ emailsSent: 50 }, quotas, { emailCents: 0.4 }).totalCents).toBe(0);
    // WhatsApp has a rate but no quota: unlimited included, nothing billable.
    expect(computeOverage({ whatsappMessages: 50 }, quotas, { whatsappMessageCents: 5 }).totalCents).toBe(0);
  });

  it.each([
    // [label, usage, quotas, rates, expected cents]
    ["1.5 tokens-k at 3c rounds half-up to 5c", { aiTokens: 2500 }, { aiTokensPerMonth: 1000 }, { aiTokensPer1kCents: 3 }, 5],
    ["1.499 tokens-k at 3c rounds down to 4c", { aiTokens: 2499 }, { aiTokensPerMonth: 1000 }, { aiTokensPer1kCents: 3 }, 4],
    ["90 s at 7c/min (10.5c) rounds half-up to 11c", { voiceSeconds: 150 }, { voiceMinutesPerMonth: 1 }, { voiceMinuteCents: 7 }, 11],
    ["29 s at 1c/min (0.48c) rounds to 0c", { voiceSeconds: 89 }, { voiceMinutesPerMonth: 1 }, { voiceMinuteCents: 1 }, 0],
    // Float maths gives (4100 / 1000) * 15 = 61.4999… → 61. The exact value is 61.5 → 62.
    ["4,100 tokens at 15c/1k is 62c, where float drift gave 61c", { aiTokens: 5100 }, { aiTokensPerMonth: 1000 }, { aiTokensPer1kCents: 15 }, 62],
    ["a fractional stored rate rounds half-up first (2.5c → 3c)", { emailsSent: 12 }, { emailsPerMonth: 10 }, { emailCents: 2.5 }, 6],
  ])("%s", (_label, usage, quotas, rates, cents) => {
    expect(computeOverage(usage, quotas, rates).totalCents).toBe(cents);
  });

  it("the total is the sum of the rounded lines, never the rounded sum", () => {
    // Each line is 0.5c before rounding: rounded per line that is 1c + 1c = 2c.
    // Summed first and rounded once it would be 1c.
    const out = computeOverage(
      { aiTokens: 1100 + 500, voiceSeconds: 60 + 30 },
      { aiTokensPerMonth: 1100, voiceMinutesPerMonth: 1 },
      { aiTokensPer1kCents: 1, voiceMinuteCents: 1 },
    );
    expect(out.perUnit).toEqual({
      aiTokens: { overUnits: 500, cents: 1 },
      voiceSeconds: { overUnits: 30, cents: 1 },
    });
    expect(out.totalCents).toBe(2);
  });

  it("stays exact for huge counters", () => {
    // 9,007,199,254,740,990 emails over at 1c: past float's exact-integer
    // range once multiplied, exact here.
    const used = Number.MAX_SAFE_INTEGER;
    expect(computeOverage({ emailsSent: used }, { emailsPerMonth: 1 }, { emailCents: 1 }).totalCents).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    // 10^12 tokens over at 99,999c per 1k = 99,999,000,000,000c exactly.
    expect(
      computeOverage({ aiTokens: 1e12 + 1000 }, { aiTokensPerMonth: 1000 }, { aiTokensPer1kCents: 99_999 }).totalCents,
    ).toBe(99_999_000_000_000);
    // 10^12 + 500 tokens over at 3c per 1k = 3,000,000,001.5c → 3,000,000,002c.
    expect(
      computeOverage({ aiTokens: 1e12 + 1500 }, { aiTokensPerMonth: 1000 }, { aiTokensPer1kCents: 3 }).totalCents,
    ).toBe(3_000_000_002);
  });
});

describe("computeOverage on malformed ledger values and rates", () => {
  const quotas = { emailsPerMonth: 100 };
  const rates = { emailCents: 7 };
  const over = (used: unknown, r: Record<string, unknown> = rates) =>
    computeOverage({ emailsSent: used as number }, quotas, r as typeof rates);

  it("a fractional count bills whole units only (101.5 → 1 over)", () => {
    expect(over(101.5)).toEqual({ perUnit: { emailsSent: { overUnits: 1, cents: 7 } }, totalCents: 7 });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -500],
    ["a string", "150"],
    ["null", null],
    ["an object", { n: 150 }],
  ])("used = %s bills nothing and does not throw", (_label, used) => {
    expect(over(used)).toEqual({ perUnit: {}, totalCents: 0 });
  });

  it.each([
    ["negative", -7],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "7"],
  ])("rate = %s bills nothing and does not throw", (_label, rate) => {
    expect(over(150, { emailCents: rate })).toEqual({ perUnit: {}, totalCents: 0 });
  });

  it("a fractional rate rounds half-up (7.5 → 8 per unit)", () => {
    expect(over(102, { emailCents: 7.5 }).totalCents).toBe(16);
  });

  it("a huge rate whose line can't be held exactly is skipped, not rounded, and other lines survive", () => {
    const out = computeOverage(
      { emailsSent: 1e6, smsSegments: 11 },
      { emailsPerMonth: 1, smsSegmentsPerMonth: 10 },
      { emailCents: 1e300, smsSegmentCents: 5 },
    );
    expect(out).toEqual({ perUnit: { smsSegments: { overUnits: 1, cents: 5 } }, totalCents: 5 });
  });

  it("a line that would push the total past 2^53 is skipped", () => {
    const big = Number.MAX_SAFE_INTEGER - 10;
    const out = computeOverage(
      { emailsSent: big + 1, smsSegments: 100 },
      { emailsPerMonth: 1, smsSegmentsPerMonth: 1 },
      { emailCents: 1, smsSegmentCents: 1 },
    );
    expect(out.totalCents).toBe(big);
    expect(Number.isSafeInteger(out.totalCents)).toBe(true);
    expect(out.perUnit.smsSegments).toBeUndefined();
  });
});

describe("sanitizeUsageRates", () => {
  it("caps a rate at 1,000,000 minor units", () => {
    expect(MAX_USAGE_RATE_CENTS).toBe(1_000_000);
    expect(sanitizeUsageRates({ emailCents: 5e9, smsSegmentCents: 1_000_000 })).toEqual({
      emailCents: 1_000_000,
      smsSegmentCents: 1_000_000,
    });
  });

  it("rounds half-up, drops what rounds to 0, negatives, NaN, Infinity and strings", () => {
    expect(
      sanitizeUsageRates({
        emailCents: 2.5,
        smsSegmentCents: 0.4,
        whatsappMessageCents: -3,
        aiTokensPer1kCents: Number.NaN,
        voiceMinuteCents: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ emailCents: 3 });
    expect(sanitizeUsageRates({ emailCents: "5" })).toBeNull();
  });
});
