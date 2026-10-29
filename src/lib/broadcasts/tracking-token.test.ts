import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  issueClickToken,
  issueOpenToken,
  verifyClickToken,
  verifyOpenToken,
} from "./tracking-token";
import { issueTrackedLinkToken } from "@/lib/tracked-links/token";

/**
 * The open and click tokens are the only thing between an anonymous request
 * and a write on someone's send row, so each way of tampering with one must
 * fail verification.
 */

const SECRET = "test-secret-for-tracking";

beforeEach(() => {
  process.env.AUTOMATIONS_TOKEN_SECRET = SECRET;
});

/** Flip one hex digit of the signature. */
function flipSig(token: string): string {
  const last = token.at(-1)!;
  return token.slice(0, -1) + (last === "0" ? "1" : "0");
}

describe("open token", () => {
  it("round-trips the ids it signed", () => {
    expect(verifyOpenToken(issueOpenToken("b1", "c1"))).toEqual({
      broadcastId: "b1",
      contactId: "c1",
    });
  });

  it("is an HMAC over a purpose-prefixed payload, not over the bare ids", () => {
    const sig = createHmac("sha256", SECRET).update("broadcast-open:b1.c1").digest("hex");
    expect(issueOpenToken("b1", "c1")).toBe(`b1.c1.${sig}`);
  });

  it("refuses a bit-flipped signature", () => {
    expect(verifyOpenToken(flipSig(issueOpenToken("b1", "c1")))).toBeNull();
  });

  it("refuses a signature moved onto another broadcast or contact", () => {
    const sig = issueOpenToken("b1", "c1").split(".")[2];
    expect(verifyOpenToken(`b2.c1.${sig}`)).toBeNull();
    expect(verifyOpenToken(`b1.c2.${sig}`)).toBeNull();
  });

  it("refuses a token signed with another secret", () => {
    const forged = issueOpenToken("b1", "c1");
    process.env.AUTOMATIONS_TOKEN_SECRET = "another-secret";
    expect(verifyOpenToken(forged)).toBeNull();
  });

  it("refuses wrong shapes and fails closed without a secret", () => {
    const good = issueOpenToken("b1", "c1");
    expect(verifyOpenToken("")).toBeNull();
    expect(verifyOpenToken("b1.c1")).toBeNull();
    expect(verifyOpenToken(`${good}.extra`)).toBeNull();
    expect(verifyOpenToken(good.slice(0, -1))).toBeNull();
    expect(verifyOpenToken(`b/1.c1.${good.split(".")[2]}`)).toBeNull();
    delete process.env.AUTOMATIONS_TOKEN_SECRET;
    expect(verifyOpenToken(good)).toBeNull();
  });

  it("does not accept a click token or an /l/ tracked-link token", () => {
    // Same secret, same id shapes: only the purpose prefix keeps them apart.
    const click = issueClickToken("b1", "c1", "k1");
    expect(verifyOpenToken(click)).toBeNull();
    expect(verifyOpenToken(issueTrackedLinkToken("b1", "c1"))).toBeNull();
  });

  it("refuses to mint for an id that can't survive the split", () => {
    expect(() => issueOpenToken("b.1", "c1")).toThrow();
    expect(() => issueOpenToken("b1", "")).toThrow();
  });
});

describe("click token", () => {
  it("round-trips the ids and link key it signed", () => {
    expect(verifyClickToken(issueClickToken("b1", "c1", "abc123"))).toEqual({
      broadcastId: "b1",
      contactId: "c1",
      linkKey: "abc123",
    });
  });

  it("refuses a bit-flipped signature", () => {
    expect(verifyClickToken(flipSig(issueClickToken("b1", "c1", "k1")))).toBeNull();
  });

  it("refuses a signature moved onto another broadcast, contact or link", () => {
    const sig = issueClickToken("b1", "c1", "k1").split(".")[3];
    expect(verifyClickToken(`b2.c1.k1.${sig}`)).toBeNull();
    expect(verifyClickToken(`b1.c2.k1.${sig}`)).toBeNull();
    expect(verifyClickToken(`b1.c1.k2.${sig}`)).toBeNull();
  });

  it("does not accept an open token with a link key spliced in", () => {
    const [b, c, sig] = issueOpenToken("b1", "c1").split(".");
    expect(verifyClickToken(`${b}.${c}.k1.${sig}`)).toBeNull();
  });
});
