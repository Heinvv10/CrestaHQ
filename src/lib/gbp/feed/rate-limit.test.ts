import { describe, expect, it, vi } from "vitest";
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
const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:3100/x", { headers });

describe("feedClientKey", () => {
  it("prefers cf-connecting-ip, then x-real-ip, then the shared X-Forwarded-For helper", () => {
    expect(feedClientKey(req({ "cf-connecting-ip": "203.0.113.1", "x-real-ip": "10.0.0.1", "x-forwarded-for": "6.6.6.6" }))).toBe("203.0.113.1");
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
    // A fresh module: an empty table, whatever the tests above left in it.
    vi.resetModules();
    const fresh = await import("./rate-limit");
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
});
