import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * verifyQStashSignature through the REAL Upstash Receiver, with signatures
 * minted exactly as QStash mints them (HS256, iss "Upstash", sub = the
 * destination URL, body = base64url SHA-256 of the raw body — the scheme in
 * e2e/lib/qstash.ts, here parameterised by key so two accounts can sign).
 *
 * The legacy pair keeps an OLD QStash account's delayed deliveries (workflow
 * waits, 24 h mystery-shop timers) verifiable after production moves to a
 * new account.
 */

const PRIMARY = { current: "sig_primary_current_key_test", next: "sig_primary_next_key_test" };
const LEGACY = { current: "sig_legacy_current_key_test", next: "sig_legacy_next_key_test" };
const URL_ = "https://app.example.com/api/automations/prospecting/mystery-shop";
const OTHER_URL = "https://app.example.com/api/cron/review-reminder";
const BODY = JSON.stringify({ runId: "r1", step: 2 });

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(key: string, url: string, body: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "Upstash",
      sub: url,
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: `jti_${now}_${Math.random()}`,
      body: createHash("sha256").update(body, "utf8").digest("base64url"),
    }),
  );
  const mac = createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${mac}`;
}

/** Fresh module per test: the receivers are cached per process. */
async function load() {
  vi.resetModules();
  return (await import("./qstash")).verifyQStashSignature;
}

beforeEach(() => {
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", PRIMARY.current);
  vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", PRIMARY.next);
  vi.stubEnv("QSTASH_LEGACY_CURRENT_SIGNING_KEY", "");
  vi.stubEnv("QSTASH_LEGACY_NEXT_SIGNING_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function withLegacy() {
  vi.stubEnv("QSTASH_LEGACY_CURRENT_SIGNING_KEY", LEGACY.current);
  vi.stubEnv("QSTASH_LEGACY_NEXT_SIGNING_KEY", LEGACY.next);
}

describe("verifyQStashSignature", () => {
  it("accepts a primary-signed call, bound to its URL or not", async () => {
    const verify = await load();
    expect(await verify(sign(PRIMARY.current, URL_, BODY), BODY, URL_)).toBe(true);
    expect(await verify(sign(PRIMARY.next, URL_, BODY), BODY)).toBe(true);
  });

  it("accepts an old-account (legacy) signature when the legacy pair is configured", async () => {
    withLegacy();
    const verify = await load();
    expect(await verify(sign(LEGACY.current, URL_, BODY), BODY, URL_)).toBe(true);
    expect(await verify(sign(LEGACY.next, URL_, BODY), BODY, URL_)).toBe(true);
    expect(await verify(sign(LEGACY.current, URL_, BODY), BODY)).toBe(true);
    // The primary path is unaffected by the legacy pair being present.
    expect(await verify(sign(PRIMARY.current, URL_, BODY), BODY, URL_)).toBe(true);
  });

  it("refuses a legacy signature when no legacy pair is configured (today's behaviour)", async () => {
    const verify = await load();
    expect(await verify(sign(LEGACY.current, URL_, BODY), BODY, URL_)).toBe(false);
  });

  it("refuses a legacy signature minted for another route", async () => {
    withLegacy();
    const verify = await load();
    expect(await verify(sign(LEGACY.current, OTHER_URL, BODY), BODY, URL_)).toBe(false);
    // Same for the primary pair, so both paths bind identically.
    expect(await verify(sign(PRIMARY.current, OTHER_URL, BODY), BODY, URL_)).toBe(false);
  });

  it("refuses a legacy signature over a different body", async () => {
    withLegacy();
    const verify = await load();
    expect(await verify(sign(LEGACY.current, URL_, BODY), `${BODY} `, URL_)).toBe(false);
  });

  it("refuses garbage and a signature from an unknown key", async () => {
    withLegacy();
    const verify = await load();
    expect(await verify("not.a.jwt", BODY, URL_)).toBe(false);
    expect(await verify("", BODY, URL_)).toBe(false);
    expect(await verify(sign("sig_some_other_account_key", URL_, BODY), BODY, URL_)).toBe(false);
  });

  it("ignores a half-configured legacy pair, and never logs a key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [current, next] of [
      [LEGACY.current, ""],
      ["", LEGACY.next],
    ]) {
      vi.stubEnv("QSTASH_LEGACY_CURRENT_SIGNING_KEY", current);
      vi.stubEnv("QSTASH_LEGACY_NEXT_SIGNING_KEY", next);
      const verify = await load();
      // Signed with whichever legacy key IS set: still refused.
      expect(await verify(sign(current || next, URL_, BODY), BODY, URL_)).toBe(false);
      expect(await verify(sign(PRIMARY.current, URL_, BODY), BODY, URL_)).toBe(true);
    }
    const logged = JSON.stringify(warn.mock.calls);
    for (const key of [...Object.values(PRIMARY), ...Object.values(LEGACY)]) {
      expect(logged).not.toContain(key);
    }
  });

  it("refuses everything when the primary pair is unset, even with a legacy pair", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    withLegacy();
    const verify = await load();
    expect(await verify(sign(LEGACY.current, URL_, BODY), BODY, URL_)).toBe(false);
  });
});
