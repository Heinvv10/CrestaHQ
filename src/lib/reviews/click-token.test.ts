import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReviewClickUrl, issueReviewClickToken, verifyReviewClickToken } from "./click-token";

/** SP5 d2 — the signed token behind a review request's tracked link (`/rr/{token}`). */

const ORIGINAL = { ...process.env };
beforeEach(() => {
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100/";
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("review click token", () => {
  it("round-trips the sub-account and request, and is stable for the same pair", () => {
    const t = issueReviewClickToken("sa_1", "req_1");
    expect(verifyReviewClickToken(t)).toEqual({ subAccountId: "sa_1", requestId: "req_1" });
    expect(issueReviewClickToken("sa_1", "req_1")).toBe(t);
  });

  it("refuses a tampered, re-pointed or malformed token", () => {
    const t = issueReviewClickToken("sa_1", "req_1");
    const [sa, , sig] = t.split(".");
    expect(verifyReviewClickToken(`${sa}.req_2.${sig}`)).toBeNull();
    expect(verifyReviewClickToken(`${t.slice(0, -1)}${t.endsWith("0") ? "1" : "0"}`)).toBeNull();
    expect(verifyReviewClickToken("sa_1.req_1")).toBeNull();
    expect(verifyReviewClickToken("")).toBeNull();
  });

  it("is not interchangeable with another token signed by the same secret", async () => {
    const { issueTrackedLinkToken } = await import("@/lib/tracked-links/token");
    expect(verifyReviewClickToken(issueTrackedLinkToken("sa_1", "req_1"))).toBeNull();
  });

  it("refuses ids that would break the split", () => {
    expect(() => issueReviewClickToken("sa.1", "req_1")).toThrow();
  });

  it("another secret's token does not verify", () => {
    const t = issueReviewClickToken("sa_1", "req_1");
    process.env.AUTOMATIONS_TOKEN_SECRET = "a-different-secret";
    expect(verifyReviewClickToken(t)).toBeNull();
  });

  it("builds the public URL on the app origin, empty without one", () => {
    expect(buildReviewClickUrl("sa_1", "req_1")).toMatch(/^http:\/\/127\.0\.0\.1:3100\/rr\/sa_1\.req_1\.[0-9a-f]{64}$/);
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(buildReviewClickUrl("sa_1", "req_1")).toBe("");
  });
});
