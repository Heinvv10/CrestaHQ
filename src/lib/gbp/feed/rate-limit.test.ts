import { describe, expect, it } from "vitest";
import { MAX_TRACKED_KEYS, PER_IP_LIMIT, PER_WIDGET_LIMIT, checkFeedRateLimit, feedClientKey } from "./rate-limit";

/**
 * The public feed's limiter: two buckets (per IP, and per IP + widget), a
 * client key that prefers the tunnel's own header over a spoofable
 * X-Forwarded-For, and eviction of the OLDEST keys — never a wholesale clear
 * that would hand every abuser a fresh budget.
 */

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
  it(`limits one IP + widget at ${PER_WIDGET_LIMIT} a minute`, () => {
    const ip = "198.18.0.1";
    for (let i = 0; i < PER_WIDGET_LIMIT; i++) expect(checkFeedRateLimit(ip, id(1)).ok).toBe(true);
    const blocked = checkFeedRateLimit(ip, id(1));
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(checkFeedRateLimit(ip, id(2)).ok).toBe(true);
  });

  it(`limits one IP across widgets at ${PER_IP_LIMIT} a minute`, () => {
    const ip = "198.18.0.2";
    for (let i = 0; i < PER_IP_LIMIT; i++) expect(checkFeedRateLimit(ip, id(i)).ok).toBe(true);
    expect(checkFeedRateLimit(ip, id(PER_IP_LIMIT + 1)).ok).toBe(false);
    expect(checkFeedRateLimit("198.18.0.3", id(1)).ok).toBe(true);
  });
});

describe("eviction", () => {
  it("drops the oldest keys when full, keeping recent counts", () => {
    const busy = "198.18.1.1";
    for (let i = 0; i < PER_WIDGET_LIMIT; i++) checkFeedRateLimit(busy, id(9));
    // Fill the table with other clients well past its bound.
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) checkFeedRateLimit(`198.19.${i >> 8}.${i & 255}`, id(1));
    // The busy client was among the OLDEST keys, so it may have been evicted —
    // but the most recent clients must still carry their counts.
    const recent = `198.19.${(MAX_TRACKED_KEYS - 1) >> 8}.${(MAX_TRACKED_KEYS - 1) & 255}`;
    for (let i = 1; i < PER_WIDGET_LIMIT; i++) expect(checkFeedRateLimit(recent, id(1)).ok).toBe(true);
    expect(checkFeedRateLimit(recent, id(1)).ok).toBe(false);
  });
});
