import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SA, resetBookingHarness, seedPage } from "@/test/booking-harness";

/**
 * The availability route's per-IP rate limit, and the E2E-only bypass
 * (rate-limit-e2e.ts) it consults. `isRateLimited`'s hit map is module-scope,
 * so each test uses its own IP (never reused across tests in this file) —
 * same technique booking-harness's `post()` uses for the book route's cap.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());

const { GET } = await import("./route");

const CAP = 120;
const req = (ip: string) => new Request("http://x/api", { headers: { "x-forwarded-for": ip } });
const call = (slug: string, ip: string) => GET(req(ip), { params: Promise.resolve({ saId: SA, slug }) });

beforeEach(() => {
  resetBookingHarness();
  delete process.env.E2E_DISABLE_BOOKING_RATE_LIMITS;
  delete process.env.NEXT_PUBLIC_APP_URL;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("availability rate limit", () => {
  it("429s the same IP after the hourly cap, and a different IP is unaffected", async () => {
    seedPage("rl-a");
    for (let i = 0; i < CAP; i++) {
      const res = await call("rl-a", "9.9.9.1");
      expect(res.status).not.toBe(429);
    }
    expect((await call("rl-a", "9.9.9.1")).status).toBe(429);
    expect((await call("rl-a", "9.9.9.2")).status).not.toBe(429);
  });

  it("does not 429 past the cap when E2E_DISABLE_BOOKING_RATE_LIMITS=1 on a loopback app URL", async () => {
    process.env.E2E_DISABLE_BOOKING_RATE_LIMITS = "1";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    seedPage("rl-b");
    for (let i = 0; i < CAP + 10; i++) {
      const res = await call("rl-b", "9.9.9.3");
      expect(res.status).not.toBe(429);
    }
  });

  it("still 429s when the env var is set but the app URL is NOT loopback", async () => {
    process.env.E2E_DISABLE_BOOKING_RATE_LIMITS = "1";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    seedPage("rl-c");
    for (let i = 0; i < CAP; i++) await call("rl-c", "9.9.9.4");
    expect((await call("rl-c", "9.9.9.4")).status).toBe(429);
  });
});

describe("availability rate limit — client IP", () => {
  it("a caller rotating the left-most X-Forwarded-For entry does not get a fresh budget", async () => {
    seedPage("rl-xff");
    for (let i = 0; i < CAP; i++) await call("rl-xff", `10.1.${i >> 8}.${i & 255}, 9.9.9.5`);
    expect((await call("rl-xff", "10.200.0.1, 9.9.9.5")).status).toBe(429);
  });
});
