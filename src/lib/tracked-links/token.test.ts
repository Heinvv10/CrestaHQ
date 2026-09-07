import { beforeAll, describe, expect, it } from "vitest";

import {
  buildTrackedLinkUrl,
  issueTrackedLinkToken,
  verifyTrackedLinkToken,
} from "./token";

/**
 * The tracked-link token is the only thing standing between a public URL
 * and "this click was made by contact X" — which enrols that contact in a
 * workflow that can WhatsApp them. A token that verifies when it shouldn't
 * lets anyone enrol anyone.
 */

beforeAll(() => {
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
});

describe("verifyTrackedLinkToken", () => {
  it("verifies a token it just issued", () => {
    const token = issueTrackedLinkToken("link1", "contactA");
    expect(verifyTrackedLinkToken(token)).toEqual({
      linkId: "link1",
      contactId: "contactA",
    });
  });

  it("rejects a tampered payload (contact swapped, signature kept)", () => {
    const token = issueTrackedLinkToken("link1", "contactA");
    const [linkId, , sig] = token.split(".");
    expect(verifyTrackedLinkToken(`${linkId}.contactB.${sig}`)).toBeNull();
  });

  it("rejects a token minted for link A when presented as link B", () => {
    const forLinkA = issueTrackedLinkToken("linkA", "contactA");
    const [, contactId, sig] = forLinkA.split(".");
    expect(verifyTrackedLinkToken(`linkB.${contactId}.${sig}`)).toBeNull();
  });

  it("rejects a signature from a different secret", () => {
    const token = issueTrackedLinkToken("link1", "contactA");
    process.env.AUTOMATIONS_TOKEN_SECRET = "another-secret";
    try {
      expect(verifyTrackedLinkToken(token)).toBeNull();
    } finally {
      process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
    }
  });

  it("rejects garbage shapes", () => {
    for (const bad of [
      "",
      "link1",
      "link1.contactA",
      "link1.contactA.sig.extra",
      "link1.contactA.",
      "link1.contactA.notahexsignature",
      "..",
    ]) {
      expect(verifyTrackedLinkToken(bad), bad).toBeNull();
    }
  });

  it("refuses to mint for ids that would break the split", () => {
    expect(() => issueTrackedLinkToken("link.1", "contactA")).toThrow();
    expect(() => issueTrackedLinkToken("link1", "contact/A")).toThrow();
    expect(() => issueTrackedLinkToken("link1", "")).toThrow();
  });

  it("is deterministic, so re-minting hands back the same URL", () => {
    expect(issueTrackedLinkToken("link1", "contactA")).toBe(
      issueTrackedLinkToken("link1", "contactA"),
    );
  });
});

describe("buildTrackedLinkUrl", () => {
  it("builds an absolute /l/ URL from the configured origin", () => {
    const original = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com/";
    try {
      expect(buildTrackedLinkUrl("tok")).toBe("https://crm.crestahq.com/l/tok");
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = original;
    }
  });
});
