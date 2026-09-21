import { afterEach, describe, expect, it, vi } from "vitest";
import { checkFeedRateLimit, feedClientKey } from "./rate-limit";

/**
 * The public feed's limiter: two buckets (per IP, and per IP + widget), a
 * client key that prefers the tunnel's own header over a spoofable
 * X-Forwarded-For, and eviction of the OLDEST keys — never a wholesale clear
 * that would hand every abuser a fresh budget. The limits are the documented
 * contract (docs/features/gbp-reviews.md), so they are literals here.
 */

const PER_WIDGET = 120;
const PER_CLIENT = 300;

const id = (n: number) => `W${String(n).padStart(31, "0")}`;
const ORIGINAL = { ...process.env };
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL };
});
/** A fresh limiter: an empty table, whatever earlier tests left in it. */
async function freshLimiter() {
  vi.resetModules();
  return import("./rate-limit");
}
const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:3100/x", { headers });

describe("feedClientKey", () => {
  const all = { "cf-connecting-ip": "203.0.113.1", "x-real-ip": "10.0.0.1", "x-forwarded-for": "6.6.6.6" };

  it("ignores cf-connecting-ip unless TRUST_CF_CONNECTING_IP=1 (a client could send its own)", () => {
    delete process.env.TRUST_CF_CONNECTING_IP;
    expect(feedClientKey(req(all))).toBe("10.0.0.1");
    expect(feedClientKey(req({ "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "6.6.6.6, 7.7.7.7" }))).toBe("6.6.6.6");
    process.env.TRUST_CF_CONNECTING_IP = "true";
    expect(feedClientKey(req(all))).toBe("10.0.0.1");
  });

  it("with TRUST_CF_CONNECTING_IP=1 prefers cf-connecting-ip, then x-real-ip, then X-Forwarded-For", () => {
    process.env.TRUST_CF_CONNECTING_IP = "1";
    expect(feedClientKey(req(all))).toBe("203.0.113.1");
    expect(feedClientKey(req({ "x-real-ip": "10.0.0.1", "x-forwarded-for": "6.6.6.6" }))).toBe("10.0.0.1");
    expect(feedClientKey(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" }))).toBe("6.6.6.6");
    expect(feedClientKey(req({}))).toBe("unknown");
  });
});

describe("two buckets", () => {
  it("limits one IP + widget at 120 a minute", () => {
    const ip = "198.18.0.1";
    for (let i = 0; i < PER_WIDGET; i++) expect(checkFeedRateLimit(ip, id(1)).ok).toBe(true);
    const blocked = checkFeedRateLimit(ip, id(1));
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(checkFeedRateLimit(ip, id(2)).ok).toBe(true);
  });

  it("limits one IP across widgets at 300 a minute", () => {
    const ip = "198.18.0.2";
    for (let i = 0; i < PER_CLIENT; i++) expect(checkFeedRateLimit(ip, id(i)).ok).toBe(true);
    expect(checkFeedRateLimit(ip, id(PER_CLIENT + 1)).ok).toBe(false);
    expect(checkFeedRateLimit("198.18.0.3", id(1)).ok).toBe(true);
  });
});

describe("eviction", () => {
  it("drops only the OLDEST keys on overflow — a client added just before keeps its count", async () => {
    const fresh = await freshLimiter();
    // Other clients fill the table to exactly two keys short of the bound (each hit makes two keys).
    for (let i = 0; i < fresh.MAX_TRACKED_KEYS / 2 - 1; i++) fresh.checkFeedRateLimit(`198.20.${i >> 8}.${i & 255}`, id(1));
    // A recent client spends its whole per-widget budget: the table is now exactly full.
    const recent = "198.21.0.1";
    for (let i = 0; i < PER_WIDGET; i++) expect(fresh.checkFeedRateLimit(recent, id(7)).ok).toBe(true);
    // One more new client overflows it by two keys.
    fresh.checkFeedRateLimit("198.21.0.2", id(1));
    // Oldest-first eviction kept the recent client's bucket; a wholesale clear would not have.
    expect(fresh.checkFeedRateLimit(recent, id(7)).ok).toBe(false);
  });

  it("is least-RECENTLY-used: a persistent abuser is not evicted while 5,000 newer clients fill the table", async () => {
    const fresh = await freshLimiter();
    const abuser = "198.30.0.1";
    for (let i = 0; i < PER_WIDGET; i++) fresh.checkFeedRateLimit(abuser, id(1));
    expect(fresh.checkFeedRateLimit(abuser, id(1)).ok).toBe(false);
    // The review's probe: 5,000 newer clients (10,000 keys — the whole table) arrive
    // while the abuser keeps knocking.
    for (let i = 0; i < fresh.MAX_TRACKED_KEYS / 2; i++) {
      fresh.checkFeedRateLimit(`198.31.${i >> 8}.${i & 255}`, id(2));
      if (i % 100 === 99) expect(fresh.checkFeedRateLimit(abuser, id(1)).ok).toBe(false);
    }
    expect(fresh.checkFeedRateLimit(abuser, id(1)).ok).toBe(false);
  });

  it("sweeps expired windows before evicting anything still counting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const fresh = await freshLimiter();
    // K1's window opens at t0; it is touched again at t0+59s, so it is the MOST recent key —
    // but its window expires at t0+60s.
    fresh.checkFeedRateLimit("198.40.0.1", id(1));
    vi.setSystemTime(t0 + 30_000);
    // K2 spends its whole per-widget budget at t0+30s: the least recent key still counting.
    const k2 = "198.40.0.2";
    for (let i = 0; i < PER_WIDGET; i++) fresh.checkFeedRateLimit(k2, id(2));
    for (let i = 0; i < fresh.MAX_TRACKED_KEYS / 2 - 2; i++) fresh.checkFeedRateLimit(`198.41.${i >> 8}.${i & 255}`, id(3));
    vi.setSystemTime(t0 + 59_000);
    fresh.checkFeedRateLimit("198.40.0.1", id(1));
    // Full. At t0+61s one new client overflows by two keys: K1's expired keys go, K2 stays.
    vi.setSystemTime(t0 + 61_000);
    fresh.checkFeedRateLimit("198.40.0.3", id(4));
    expect(fresh.checkFeedRateLimit(k2, id(2)).ok).toBe(false);
  });
});

describe("eviction cost", () => {
  it("does not sweep the whole table on every request when a flood of new clients arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const fresh = await freshLimiter();
    for (let i = 0; i < fresh.MAX_TRACKED_KEYS / 2; i++) fresh.checkFeedRateLimit(`198.60.${i >> 8}.${i & 255}`, id(1));
    // 5,000 more unique clients within the same second: every one overflows the table.
    for (let i = 0; i < fresh.MAX_TRACKED_KEYS / 2; i++) fresh.checkFeedRateLimit(`198.61.${i >> 8}.${i & 255}`, id(1));
    expect(fresh.limiterStats().sweeps).toBe(1);
    // A second later the next overflow may sweep again.
    vi.setSystemTime(t0 + 1_000);
    fresh.checkFeedRateLimit("198.62.0.1", id(1));
    expect(fresh.limiterStats().sweeps).toBe(2);
  });
});

describe("a per-client refusal", () => {
  it("does not spend the per-widget budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const fresh = await freshLimiter();
    const c = "198.50.0.1";
    for (let i = 0; i < 100; i++) fresh.checkFeedRateLimit(c, id(1)); // per-client window opens at t0
    vi.setSystemTime(t0 + 20_000);
    for (let i = 0; i < 115; i++) expect(fresh.checkFeedRateLimit(c, id(4)).ok).toBe(true); // widget 4's window opens at t0+20s
    for (let i = 0; i < 85; i++) fresh.checkFeedRateLimit(c, id(2)); // per-client now at 300
    for (let i = 0; i < 10; i++) expect(fresh.checkFeedRateLimit(c, id(4)).ok).toBe(false); // refused per client
    // The per-client window restarts; widget 4's is still open at 115 — not 125.
    vi.setSystemTime(t0 + 61_000);
    for (let i = 0; i < 5; i++) expect(fresh.checkFeedRateLimit(c, id(4)).ok).toBe(true);
    expect(fresh.checkFeedRateLimit(c, id(4)).ok).toBe(false);
  });
});
