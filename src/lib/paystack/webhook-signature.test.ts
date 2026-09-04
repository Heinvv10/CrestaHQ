import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyPaystackSignature } from "./webhook-signature";

/**
 * The signature IS the authentication on a public endpoint that activates paid
 * workspaces and marks charges paid. Anything that weakens it lets whoever
 * guesses the URL grant themselves a plan.
 */

const SECRET = "sk_test_secret";
const BODY = '{"event":"charge.success","data":{"reference":"ref_1"}}';
const sign = (body: string, key = SECRET) =>
  createHmac("sha512", key).update(body).digest("hex");

describe("verifyPaystackSignature", () => {
  it("accepts a signature over the exact raw body", () => {
    expect(verifyPaystackSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    const signature = sign(BODY);
    const tampered = BODY.replace("ref_1", "ref_2");
    expect(verifyPaystackSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different key", () => {
    expect(
      verifyPaystackSignature(BODY, sign(BODY, "sk_test_other"), SECRET),
    ).toBe(false);
  });

  it("rejects a missing signature rather than treating it as absent-and-fine", () => {
    expect(verifyPaystackSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyPaystackSignature(BODY, "", SECRET)).toBe(false);
  });

  it("returns false for a wrong-length signature instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths; an exception here would
    // surface as a 500 and make Paystack retry a forgery forever.
    expect(verifyPaystackSignature(BODY, "abc", SECRET)).toBe(false);
  });

  it("is not satisfied by SHA-256, the algorithm it would be easy to reach for", () => {
    const sha256 = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyPaystackSignature(BODY, sha256, SECRET)).toBe(false);
  });
});
