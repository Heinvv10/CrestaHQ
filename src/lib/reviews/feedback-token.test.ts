import { beforeAll, describe, expect, it } from "vitest";

/**
 * Regression tests for the public review-page token.
 *
 * The token IS the authorisation for an unauthenticated endpoint, so each test
 * here corresponds to a way a stranger could get in. If one of these ever goes
 * green-to-red, the public endpoint is exposed.
 */

// The module reads the secret at call time, so setting it before the dynamic
// import is enough.
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";

let issueReviewToken: typeof import("./feedback-token").issueReviewToken;
let verifyReviewToken: typeof import("./feedback-token").verifyReviewToken;
let hashReviewToken: typeof import("./feedback-token").hashReviewToken;
let buildReviewPageUrl: typeof import("./feedback-token").buildReviewPageUrl;

beforeAll(async () => {
  const mod = await import("./feedback-token");
  issueReviewToken = mod.issueReviewToken;
  verifyReviewToken = mod.verifyReviewToken;
  hashReviewToken = mod.hashReviewToken;
  buildReviewPageUrl = mod.buildReviewPageUrl;
});

const CONTACT = "abc123DEF456";

describe("issueReviewToken", () => {
  it("round-trips: an issued token verifies back to its contact", () => {
    const { token, hash } = issueReviewToken(CONTACT);
    const verified = verifyReviewToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.contactId).toBe(CONTACT);
    expect(verified!.hash).toBe(hash);
  });

  it("never persists the raw token — the hash is a digest, not the token", () => {
    const { token, hash } = issueReviewToken(CONTACT);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashReviewToken(token)).toBe(hash);
  });

  it("issues a different token every time (nonce rotation invalidates re-sends)", () => {
    const a = issueReviewToken(CONTACT);
    const b = issueReviewToken(CONTACT);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it("refuses a contactId containing a dot, which would break the split", () => {
    expect(() => issueReviewToken("bad.id")).toThrow();
  });
});

describe("verifyReviewToken — forgery resistance", () => {
  it("rejects a tampered signature", () => {
    const { token } = issueReviewToken(CONTACT);
    const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(verifyReviewToken(flipped)).toBeNull();
  });

  it("rejects a token whose contactId was swapped for someone else's", () => {
    const { token } = issueReviewToken(CONTACT);
    const [, nonce, sig] = token.split(".");
    // The attack: keep a valid signature, point it at another contact.
    expect(verifyReviewToken(`victimContact.${nonce}.${sig}`)).toBeNull();
  });

  it("rejects a forged token signed with the wrong secret", () => {
    // A token built by someone who guessed the format but not the key.
    const forged = `${CONTACT}.${"a".repeat(32)}.${"b".repeat(64)}`;
    expect(verifyReviewToken(forged)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no dots", "notatoken"],
    ["too few parts", "a.b"],
    ["too many parts", "a.b.c.d"],
    ["empty segments", "..'"],
  ])("rejects a malformed token (%s)", (_label, bad) => {
    expect(verifyReviewToken(bad)).toBeNull();
  });
});

describe("buildReviewPageUrl", () => {
  it("returns an empty string rather than throwing when the app URL is unset", () => {
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(buildReviewPageUrl("tok")).toBe("");
    if (prev !== undefined) process.env.NEXT_PUBLIC_APP_URL = prev;
  });

  it("does not double up the slash when the app URL has a trailing one", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com/";
    expect(buildReviewPageUrl("tok")).toBe("https://example.com/r/tok");
  });
});
