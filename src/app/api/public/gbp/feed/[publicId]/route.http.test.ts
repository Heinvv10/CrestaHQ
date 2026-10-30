import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET/OPTIONS /api/public/gbp/feed/[publicId] — HOW the feed is served: the
 * CORS allow-list, cache headers and ETag / 304, and the per-IP rate limit.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, SA, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { EVIL, VELO, createWidget, feed, freshIp, preflight } from "@/test/gbp-feed-harness";
import { syncListing } from "@/lib/gbp/sync/run";

const ORIGINAL = { ...process.env };
const CACHE = "public, max-age=60";
let ip: string;
let id: string;

beforeEach(async () => {
  resetSync();
  ip = freshIp();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  id = await createWidget({ enabled: true, allowedOrigins: [VELO, "http://127.0.0.1:4401"], maxReviews: 12 });
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("CORS: an allow-list, never *", () => {
  it("echoes an allowed Origin with Vary: Origin", async () => {
    const res = await feed(id, { "x-forwarded-for": ip, origin: VELO });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(VELO);
    expect(res.headers.get("vary")).toBe("Origin");
    const local = await feed(id, { "x-forwarded-for": ip, origin: "http://127.0.0.1:4401" });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4401");
  });

  it.each([EVIL, "https://velocityfibre.co.za", "http://www.velocityfibre.co.za", "https://www.velocityfibre.co.za:8443", "null"])(
    "refuses Origin %s with 403 origin_not_allowed and no CORS grant",
    async (origin) => {
      const res = await feed(id, { "x-forwarded-for": ip, origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "origin_not_allowed" });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("serves a request with no Origin (a server, curl) without a CORS header", async () => {
    const res = await feed(id, { "x-forwarded-for": ip });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("answers a preflight from an allowed origin, refuses the rest, and 404s an unknown id", async () => {
    const ok = await preflight(id, { "x-forwarded-for": ip, origin: VELO, "access-control-request-method": "GET" });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(VELO);
    expect(ok.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(ok.headers.get("vary")).toBe("Origin");
    const evil = await preflight(id, { "x-forwarded-for": ip, origin: EVIL });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const unknown = await preflight("B".repeat(32), { "x-forwarded-for": ip, origin: VELO });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('{"error":"not_found"}');
  });
});

describe("cache headers and ETag", () => {
  it("is publicly cacheable for 60s (no stale-while-revalidate) with a strong ETag", async () => {
    const res = await feed(id, { "x-forwarded-for": ip });
    expect(res.headers.get("cache-control")).toBe(CACHE);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("keeps the same ETag across requests (generatedAt is not part of it) and 304s a match", async () => {
    const a = await feed(id, { "x-forwarded-for": ip });
    await new Promise((r) => setTimeout(r, 5));
    const b = await feed(id, { "x-forwarded-for": ip });
    const [bodyA, bodyB] = [(await a.json()) as { freshness: { generatedAt: string } }, (await b.json()) as { freshness: { generatedAt: string } }];
    expect(bodyA.freshness.generatedAt).not.toBe(bodyB.freshness.generatedAt);
    const etag = a.headers.get("etag")!;
    expect(b.headers.get("etag")).toBe(etag);

    const notModified = await feed(id, { "x-forwarded-for": ip, origin: VELO, "if-none-match": etag });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(notModified.headers.get("access-control-allow-origin")).toBe(VELO);
    expect(notModified.headers.get("vary")).toBe("Origin");
    expect(notModified.headers.get("cache-control")).toBe(CACHE);

    const listed = await feed(id, { "x-forwarded-for": ip, "if-none-match": `"nope", ${etag}` });
    expect(listed.status).toBe(304);
    const other = await feed(id, { "x-forwarded-for": ip, "if-none-match": '"nope"' });
    expect(other.status).toBe(200);
    // Weak comparison, as RFC 9110 asks of If-None-Match: a compressing proxy may weaken the tag.
    expect((await feed(id, { "x-forwarded-for": ip, "if-none-match": `W/${etag}` })).status).toBe(304);
    expect((await feed(id, { "x-forwarded-for": ip, "if-none-match": "*" })).status).toBe(304);
  });

  it("changes the ETag and the body when a review changes at Google and is synced — no site rebuild", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = await feed(id, { "x-forwarded-for": ip });
    const etag = before.headers.get("etag")!;
    setScenario(SA, (s) => {
      const r = s.reviews[LOC_A].reviews[0];
      r.comment = "Edited at Google: still great.";
      r.updateTime = "2026-09-10T09:00:00Z";
    });
    await syncListing(SA, { trigger: "scheduled" });
    // Past the feed's 60s review-scan memo.
    vi.setSystemTime(Date.now() + 61_000);
    const after = await feed(id, { "x-forwarded-for": ip, "if-none-match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    const body = (await after.json()) as { reviews: Array<{ text: string | null; updatedAt: string }> };
    expect(body.reviews[0]).toMatchObject({ text: "Edited at Google: still great.", updatedAt: "2026-09-10T09:00:00.000Z" });
  });
});

describe("rate limit: 120 a minute per IP and widget", () => {
  it("with TRUST_CF_CONNECTING_IP=1, keys on cf-connecting-ip, so a rotating X-Forwarded-For does not reset the budget", async () => {
    process.env.TRUST_CF_CONNECTING_IP = "1";
    const cf = `cf-${ip}`;
    for (let i = 0; i < 120; i++) {
      expect((await feed(id, { "cf-connecting-ip": cf, "x-forwarded-for": `203.0.113.${i}` })).status).toBe(200);
    }
    expect((await feed(id, { "cf-connecting-ip": cf, "x-forwarded-for": "203.0.113.250" })).status).toBe(429);
  });

  it("without TRUST_CF_CONNECTING_IP, a client-sent cf-connecting-ip changes nothing", async () => {
    delete process.env.TRUST_CF_CONNECTING_IP;
    for (let i = 0; i < 120; i++) {
      expect((await feed(id, { "cf-connecting-ip": `198.51.99.${i}`, "x-forwarded-for": ip })).status).toBe(200);
    }
    expect((await feed(id, { "cf-connecting-ip": "198.51.99.250", "x-forwarded-for": ip })).status).toBe(429);
  });

  it("checks the id's shape BEFORE the limiter: junk ids spend no budget", async () => {
    for (let i = 0; i < 400; i++) expect((await feed(`junk-${i}`, { "x-forwarded-for": ip })).status).toBe(404);
    expect((await feed(id, { "x-forwarded-for": ip })).status).toBe(200);
  });

  it("429s the 121st request with Retry-After and no-store, without touching other IPs or widgets", async () => {
    for (let i = 0; i < 120; i++) expect((await feed(id, { "x-forwarded-for": ip })).status).toBe(200);
    const limited = await feed(id, { "x-forwarded-for": ip, origin: VELO });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("access-control-allow-origin")).toBeNull();

    expect((await feed(id, { "x-forwarded-for": freshIp() })).status).toBe(200);
    const other = await createWidget({ enabled: true, allowedOrigins: [] }, "sa_2", "uid_other_admin");
    expect((await feed(other, { "x-forwarded-for": ip })).status).toBe(200);
    expect(mem.list("gbpWidgets")).toHaveLength(2);
  });
});
