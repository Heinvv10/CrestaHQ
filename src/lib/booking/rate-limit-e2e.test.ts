import { afterEach, describe, expect, it } from "vitest";
import { bookingRateLimitsDisabled } from "./rate-limit-e2e";

/**
 * The escape hatch the public booking rate limiters consult (see
 * rate-limit-e2e.ts). Both clauses are load-bearing — mutate either one out
 * and a test here goes red.
 */

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("bookingRateLimitsDisabled", () => {
  it("is false when the env var is unset", () => {
    delete process.env.E2E_DISABLE_BOOKING_RATE_LIMITS;
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    expect(bookingRateLimitsDisabled()).toBe(false);
  });

  it("is false when the env var is set but NEXT_PUBLIC_APP_URL is not loopback", () => {
    process.env.E2E_DISABLE_BOOKING_RATE_LIMITS = "1";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    expect(bookingRateLimitsDisabled()).toBe(false);
  });

  it("is true only when the env var is set AND the app URL is loopback", () => {
    process.env.E2E_DISABLE_BOOKING_RATE_LIMITS = "1";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    expect(bookingRateLimitsDisabled()).toBe(true);
  });

  it("rejects a non-exact value for the env var", () => {
    process.env.E2E_DISABLE_BOOKING_RATE_LIMITS = "true";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    expect(bookingRateLimitsDisabled()).toBe(false);
  });

  it("fails closed on an unparseable app URL", () => {
    process.env.E2E_DISABLE_BOOKING_RATE_LIMITS = "1";
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(bookingRateLimitsDisabled()).toBe(false);
  });

  it("fails closed when NEXT_PUBLIC_APP_URL is unset", () => {
    process.env.E2E_DISABLE_BOOKING_RATE_LIMITS = "1";
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(bookingRateLimitsDisabled()).toBe(false);
  });
});
