import { afterEach, describe, expect, it } from "vitest";
import { clientIpFrom } from "./rate-limit";

/**
 * The one client-IP helper every per-IP limiter keys on. The left-most
 * X-Forwarded-For entry is whatever the CALLER sent — a proxy appends the
 * address it saw — so keying on it lets anyone mint a fresh budget per request.
 */

const req = (headers: Record<string, string>) => new Request("http://x/", { headers });
const ORIGINAL = process.env.TRUST_CF_CONNECTING_IP;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
  else process.env.TRUST_CF_CONNECTING_IP = ORIGINAL;
});

describe("clientIpFrom", () => {
  it("takes the right-most X-Forwarded-For hop (the one our proxy appended), not the caller's", () => {
    delete process.env.TRUST_CF_CONNECTING_IP;
    expect(clientIpFrom(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIpFrom(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores a caller-sent cf-connecting-ip unless the deployment says it sits behind the tunnel", () => {
    delete process.env.TRUST_CF_CONNECTING_IP;
    expect(clientIpFrom(req({ "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    process.env.TRUST_CF_CONNECTING_IP = "1";
    expect(clientIpFrom(req({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "6.6.6.6, 198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("falls back to x-real-ip, then a shared sentinel", () => {
    delete process.env.TRUST_CF_CONNECTING_IP;
    expect(clientIpFrom(req({ "x-real-ip": "198.51.100.8" }))).toBe("198.51.100.8");
    expect(clientIpFrom(req({}))).toBe("unknown");
  });
});
