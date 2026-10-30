import { Timestamp } from "firebase-admin/firestore";
import { expect, it } from "vitest";
import { serializeQuote } from "./public-quote";

/**
 * The /q/[token] page's props reach the browser whole (RSC payload). A signed
 * quote's signature must arrive as who signed and when only: never the
 * signer's email, IP, user agent or the stored fingerprint.
 */

const SIGNED_AT = Timestamp.fromDate(new Date("2026-10-29T10:00:00Z"));
const QUOTE = {
  id: "q1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", kind: "quote", status: "accepted", quoteNumber: "Q-1",
  currency: "ZAR", lineItems: [], validUntil: null, createdAt: null, updatedAt: null,
  signature: {
    signerName: "Jane Doe", signedAsNumber: "Q-1", signerEmail: "jane-private@example.com", signedAt: SIGNED_AT,
    ipAddress: "203.0.113.99", userAgent: "SentinelAgent/1.0", documentHash: "f".repeat(64), hashVersion: 1,
  },
};

it("cuts the signature to the signer's name and the time", () => {
  const out = serializeQuote(QUOTE as never);
  expect(out.signature).toEqual({ signerName: "Jane Doe", signedAt: SIGNED_AT.toMillis() });
  const wire = JSON.stringify(out);
  for (const secret of ["jane-private@example.com", "203.0.113.99", "SentinelAgent/1.0", "f".repeat(64), "signedAsNumber", "hashVersion"]) {
    expect(wire).not.toContain(secret);
  }
});

it("an unsigned quote serialises signature: null", () => {
  expect(serializeQuote({ ...QUOTE, signature: undefined } as never).signature).toBeNull();
});
