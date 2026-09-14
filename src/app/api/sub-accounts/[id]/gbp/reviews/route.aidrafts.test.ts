import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET …/gbp/reviews tells the composer whether "Draft with AI" can work:
 * `aiDrafts` is true only with the Google gate AND the Reviews AI gate on and
 * Reviews AI configured on this deployment. Real route and gates.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { GET } from "./route";

const ORIGINAL = { ...process.env };
const get = async (uid = "uid_admin") =>
  (await (await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/reviews`, uid), { params: Promise.resolve({ id: SA }) })).json()) as { aiDrafts?: boolean };
const patchSub = (patch: Record<string, unknown>) => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, ...patch });

beforeEach(() => {
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = AGENCY;
  patchSub({ reviewsAiEnabledByAgency: true });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("aiDrafts", () => {
  it("is true with both gates on and Reviews AI configured", async () => {
    expect((await get()).aiDrafts).toBe(true);
  });

  it("is false with the Reviews AI gate off or unset", async () => {
    patchSub({ reviewsAiEnabledByAgency: false });
    expect((await get()).aiDrafts).toBe(false);
    patchSub({ reviewsAiEnabledByAgency: undefined });
    expect((await get()).aiDrafts).toBe(false);
  });

  it("is false when Reviews AI is not configured here", async () => {
    delete process.env.REVIEWS_AI_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    expect((await get()).aiDrafts).toBe(false);
  });
});
