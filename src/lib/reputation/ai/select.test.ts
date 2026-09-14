import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const callAi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/comms/ai/openrouter", () => ({
  callAi,
  aiIsConfigured: () => !!process.env.OPENROUTER_API_KEY,
  defaultAiModel: () => "anthropic/claude-haiku-4-5",
}));

import { FOREIGN_AGENCY, FOREIGN_SA, SA, mem, resetSync, seedSub } from "@/test/gbp-sync-harness";
import { ReviewsAiFakeRefusedError, reviewsAiConfigured, reviewsAiMode } from "./mode";
import { fakeLogPath } from "./fake";
import { getReviewsAiFor } from "./select";

/**
 * The Reviews AI fake must be impossible to reach in production and — dev
 * and CI run against the PRODUCTION Firestore — impossible to aim at a real
 * tenant. One test per fence clause; a requested-but-refused fake THROWS and
 * never falls back to OpenRouter.
 */

const ORIGINAL = { ...process.env };

function fakeEnv() {
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  delete process.env.REVIEWS_AI_FAKE_ALLOW_PROD_BUILD;
  delete process.env.OPENROUTER_API_KEY;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

beforeEach(() => {
  resetSync();
  seedSub(FOREIGN_SA, { agencyId: FOREIGN_AGENCY });
  fakeEnv();
  callAi.mockReset();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("reviewsAiMode — the four clauses", () => {
  it("is openrouter unless REVIEWS_AI_PROVIDER is exactly 'fake'", () => {
    for (const v of [undefined, "", "openrouter", "FAKE", "fake "]) {
      if (v === undefined) delete process.env.REVIEWS_AI_PROVIDER;
      else process.env.REVIEWS_AI_PROVIDER = v;
      expect(reviewsAiMode()).toBe("openrouter");
    }
  });

  it("is fake with every clause satisfied", () => {
    expect(reviewsAiMode()).toBe("fake");
  });

  it("refuses a non-loopback app URL, with the message the deploy guard anchors on", () => {
    for (const url of ["https://crm.crestahq.com", "http://0.0.0.0:3100", "http://127.0.0.2", "", "not a url"]) {
      process.env.NEXT_PUBLIC_APP_URL = url;
      expect(() => reviewsAiMode()).toThrow("NEXT_PUBLIC_APP_URL is not loopback (Reviews AI fake)");
    }
  });

  it("refuses a production build unless REVIEWS_AI_FAKE_ALLOW_PROD_BUILD is exactly '1'", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    for (const v of [undefined, "", "true", "0"]) {
      if (v === undefined) delete process.env.REVIEWS_AI_FAKE_ALLOW_PROD_BUILD;
      else process.env.REVIEWS_AI_FAKE_ALLOW_PROD_BUILD = v;
      expect(() => reviewsAiMode()).toThrow(ReviewsAiFakeRefusedError);
    }
    process.env.REVIEWS_AI_FAKE_ALLOW_PROD_BUILD = "1";
    expect(reviewsAiMode()).toBe("fake");
  });

  it("refuses without REVIEWS_AI_FAKE_AGENCY_ID", () => {
    delete process.env.REVIEWS_AI_FAKE_AGENCY_ID;
    expect(() => reviewsAiMode()).toThrow(ReviewsAiFakeRefusedError);
  });
});

describe("reviewsAiConfigured", () => {
  it("an allowed fake is configured; a refused fake is not, even with an OpenRouter key", () => {
    expect(reviewsAiConfigured()).toBe(true);
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    expect(reviewsAiConfigured()).toBe(false);
  });

  it("openrouter mode is configured only with a key", () => {
    delete process.env.REVIEWS_AI_PROVIDER;
    expect(reviewsAiConfigured()).toBe(false);
    process.env.OPENROUTER_API_KEY = "sk-test";
    expect(reviewsAiConfigured()).toBe(true);
  });
});

describe("getReviewsAiFor — the fixture-agency fence", () => {
  it("gives the fake for a fixture sub-account, and it logs ids and count, never text", async () => {
    const ai = await getReviewsAiFor(SA);
    const out = await ai.classifySentiment([{ id: "a", starRating: 5, text: "Fast and friendly." }]);
    expect(out).toEqual([{ id: "a", label: "positive" }]);
    expect(ai.model).toBe("fake");
    const log = mem.read(fakeLogPath(SA));
    expect(log?.calls).toEqual([{ at: expect.any(Number), ids: ["a"], count: 1 }]);
    expect(JSON.stringify(log)).not.toContain("friendly");
    expect(callAi).not.toHaveBeenCalled();
  });

  it("refuses a sub-account of another agency before any call — and does not fall back to OpenRouter", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    await expect(getReviewsAiFor(FOREIGN_SA)).rejects.toThrow(ReviewsAiFakeRefusedError);
    expect(callAi).not.toHaveBeenCalled();
    expect(mem.read(fakeLogPath(FOREIGN_SA))).toBeUndefined();
  });

  it("a refused fake (non-loopback URL) throws rather than using OpenRouter", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    await expect(getReviewsAiFor(SA)).rejects.toThrow(ReviewsAiFakeRefusedError);
    expect(callAi).not.toHaveBeenCalled();
  });

  it("openrouter mode gives the real classifier on the default model", async () => {
    delete process.env.REVIEWS_AI_PROVIDER;
    process.env.OPENROUTER_API_KEY = "sk-test";
    const ai = await getReviewsAiFor(SA);
    expect(ai.model).toBe("anthropic/claude-haiku-4-5");
  });
});
