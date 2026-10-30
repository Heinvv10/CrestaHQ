import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { resendWebhookKey, verifySvixRequest } from "./resend-webhook";

/** Svix's scheme, computed here independently of the module under test. */
const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_790_000_000_000;
const TS = String(NOW / 1000);
const BODY = '{"type":"email.delivered","data":{"email_id":"e1"}}';
const sign = (id: string, ts: string, body: string, key = KEY) =>
  createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
const verify = (o: Partial<Parameters<typeof verifySvixRequest>[0]> = {}) =>
  verifySvixRequest({
    key: KEY,
    id: "msg_1",
    timestamp: TS,
    signature: `v1,${sign("msg_1", TS, BODY)}`,
    body: BODY,
    nowMs: NOW,
    ...o,
  });

describe("resendWebhookKey", () => {
  it("decodes a whsec_ secret", () => {
    expect(resendWebhookKey(SECRET)?.equals(KEY)).toBe(true);
    expect(resendWebhookKey(`  ${SECRET}\n`)?.equals(KEY)).toBe(true);
  });

  it("is null — so the route refuses everything — for unset, unprefixed, non-base64 or short secrets", () => {
    for (const s of [undefined, "", "   ", KEY.toString("base64"), "whsec_", "whsec_!!!!", `whsec_${Buffer.from("short").toString("base64")}`]) {
      expect(resendWebhookKey(s)).toBeNull();
    }
  });
});

describe("verifySvixRequest", () => {
  it("returns the svix-id for a correctly signed, fresh request", () => {
    expect(verify()).toBe("msg_1");
  });

  it("accepts a match anywhere in a multi-signature header", () => {
    const sig = `v1,${sign("msg_1", TS, BODY, Buffer.from("old-secret-old-secret-old-secret"))} v1,${sign("msg_1", TS, BODY)}`;
    expect(verify({ signature: sig })).toBe("msg_1");
  });

  it("rejects a wrong key, another body, another id, another timestamp", () => {
    expect(verify({ key: Buffer.from("another-secret-another-secret!!!") })).toBeNull();
    expect(verify({ body: `${BODY} ` })).toBeNull();
    expect(verify({ id: "msg_2" })).toBeNull();
    expect(verify({ timestamp: String(Number(TS) + 1) })).toBeNull();
  });

  it("rejects a signature under another scheme version or with no version", () => {
    const sig = sign("msg_1", TS, BODY);
    expect(verify({ signature: `v2,${sig}` })).toBeNull();
    expect(verify({ signature: sig })).toBeNull();
    expect(verify({ signature: `v1,${sig.slice(0, -2)}` })).toBeNull();
  });

  it("holds a 5-minute window either side", () => {
    const at = (offsetSec: number) => {
      const ts = String(Number(TS) + offsetSec);
      return verify({ timestamp: ts, signature: `v1,${sign("msg_1", ts, BODY)}` });
    };
    expect(at(-300)).toBe("msg_1");
    expect(at(300)).toBe("msg_1");
    expect(at(-301)).toBeNull();
    expect(at(301)).toBeNull();
  });

  it("rejects missing headers, a non-numeric timestamp and an id that is not a plain token", () => {
    expect(verify({ id: null })).toBeNull();
    expect(verify({ timestamp: null })).toBeNull();
    expect(verify({ signature: null })).toBeNull();
    expect(verify({ timestamp: `${TS}.5` })).toBeNull();
    for (const id of ["msg/1", "..", "a".repeat(129)]) {
      expect(verify({ id, signature: `v1,${sign(id, TS, BODY)}` })).toBeNull();
    }
  });
});
