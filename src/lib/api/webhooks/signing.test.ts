import { describe, expect, it } from "vitest";
import {
  generateSigningSecret,
  signWebhookPayload,
  verifyWebhookSignature,
} from "./signing";

/**
 * This verifier is the ONLY credential on two publicly-routed webhooks —
 * `/api/webhooks/webinar1/sa/{id}` and `/api/webhooks/whatsapp/bridge/{id}`,
 * both listed in middleware's PUBLIC_PATH_PATTERNS. Neither route wraps the
 * call in a try/catch, so anything this function throws is an unauthenticated
 * 500 rather than a rejection.
 */

const SECRET = "whsec_test";
const BODY = '{"hello":"world"}';

describe("verifyWebhookSignature", () => {
  it("accepts a signature it just produced", () => {
    const now = new Date();
    const { header } = signWebhookPayload(SECRET, BODY, now);
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header, now }))
      .toEqual({ ok: true });
  });

  it.each([
    ["missing header", null, "missing_header"],
    ["no t= or v1=", "garbage", "malformed_header"],
    ["v1 but no t", "v1=abc", "malformed_header"],
    ["t is not a number", "t=abc,v1=deadbeef", "malformed_timestamp"],
  ])("rejects a %s", (_label, header, reason) => {
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header }),
    ).toEqual({ ok: false, reason });
  });

  it("rejects a wrong secret, a tampered body, and a tampered digest", () => {
    const now = new Date();
    const { header } = signWebhookPayload(SECRET, BODY, now);
    expect(
      verifyWebhookSignature({ secret: "whsec_other", rawBody: BODY, header, now }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: '{"hello":"mars"}', header, now }).ok,
    ).toBe(false);
    const flipped = header.replace(/v1=(.)/, (_m, c: string) =>
      `v1=${c === "0" ? "1" : "0"}`,
    );
    expect(
      verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: flipped, now }).ok,
    ).toBe(false);
  });

  it("rejects a timestamp outside tolerance in BOTH directions", () => {
    const now = new Date();
    const past = new Date(now.getTime() - 301_000);
    const future = new Date(now.getTime() + 301_000);
    for (const signedAt of [past, future]) {
      const { header } = signWebhookPayload(SECRET, BODY, signedAt);
      expect(
        verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header, now }),
      ).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    }
  });

  /**
   * The regression this file was written for.
   *
   * `timingSafeEqual` throws a RangeError unless both buffers have the same
   * BYTE length, so the comparison must be guarded. Guarding on
   * `String.length` does not guard it: that counts UTF-16 code units, and 64
   * multi-byte characters are 64 units but 128 bytes. Such a header passed the
   * guard and reached the throw — an uncaught RangeError, on an
   * unauthenticated route, from a caller with no credentials, costing the
   * server a Firestore read per request.
   *
   * The assertion is deliberately "returns a rejection" rather than "does not
   * throw": a version that threw would fail `toEqual` anyway, but stating the
   * verdict pins the behaviour rather than merely the absence of a crash.
   */
  it("rejects a multi-byte digest of equal character length without throwing", () => {
    const now = new Date();
    const { timestamp } = signWebhookPayload(SECRET, BODY, now);
    // 64 characters — the exact character length of a sha256 hex digest — but
    // 128 bytes, because every one of them encodes to two.
    const multiByte = "Ã".repeat(64);
    expect(multiByte).toHaveLength(64);
    expect(Buffer.from(multiByte, "utf8")).toHaveLength(128);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        header: `t=${timestamp},v1=${multiByte}`,
        now,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  /**
   * Cross-language contract. The Go bridge signs inbound webhooks with
   * `services/wa-agent-bridge/api/webhook.go` `signPayload`, and this function
   * verifies them, but the two live in different modules that cannot import
   * each other — every other test on both sides recomputes the digest with the
   * same implementation it is testing, so both suites stay green if either
   * side changes the signed string, the separator or the version prefix.
   *
   * This vector was produced by RUNNING the Go signer, and the identical
   * constant is asserted in `webhook_test.go`. If either implementation drifts,
   * exactly one of the two suites goes red and names the side that moved.
   * Changing this expectation is a wire-format change: every deployed bridge
   * must be redeployed with it.
   */
  it("verifies the golden vector produced by the Go signer", () => {
    const secret = "whsec_golden_vector_do_not_change";
    const rawBody =
      '{"from":"27821234567@s.whatsapp.net","text":"hallo — \\"toets\\"","messageId":"3EB0GOLDEN","at":"2026-09-05T09:00:00Z"}';
    const header =
      "t=1788600000,v1=68243cdfdf788bc7bff717acef17e8ee7aec563aa8f0c1462171c3f3146e551c";

    expect(
      verifyWebhookSignature({
        secret,
        rawBody,
        header,
        now: new Date(1788600000 * 1000),
      }),
    ).toEqual({ ok: true });
  });
});

describe("generateSigningSecret", () => {
  it("mints a prefixed 32-byte secret, never twice the same", () => {
    const a = generateSigningSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(a).not.toBe(generateSigningSecret());
  });
});
