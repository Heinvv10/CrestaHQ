import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Add website and Build both answer 429 from the website service (the hourly
 * build counter, or a workspace changing too much at once). A 429 says when
 * to come back: both routes carry the service's `Retry-After`.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1", agencyRole: "owner" } }),
  }),
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "m1" }),
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const { POST: addWebsite } = await import("./route");
const { POST: buildSite } = await import("./[siteId]/build/route");
const { websiteLimitsPath, WEBSITE_BUILDS_PER_HOUR } = await import("@/lib/server/websites-service");
const { sampleWebsiteConfig } = await import("@/types/website");

const add = () =>
  addWebsite(
    new Request("https://app.test/api/sub-accounts/sa1/website", { method: "POST", headers: { "x-user-uid": "u1" } }),
    { params: Promise.resolve({ id: "sa1" }) },
  );

const ORIGINAL_KEY = process.env.GITPAGE_API_KEY;
beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Acme" });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_KEY === undefined) delete process.env.GITPAGE_API_KEY;
  else process.env.GITPAGE_API_KEY = ORIGINAL_KEY;
});

describe("POST /api/sub-accounts/[id]/website — Add website", () => {
  it("creates a draft site", async () => {
    const res = await add();
    expect(res.status).toBe(200);
    expect(mem.list("subAccounts/sa1/website")).toHaveLength(1);
  });

  it("a 429 (too much at once) carries Retry-After", async () => {
    vi.spyOn(mem.db, "runTransaction").mockRejectedValue(Object.assign(new Error("10 ABORTED: contention"), { code: 10 }));
    const res = await add();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(mem.list("subAccounts/sa1/website")).toEqual([]);
  });

  it("the site-cap 409 carries none", async () => {
    for (let i = 0; i < 5; i++) await add();
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});

describe("POST /api/sub-accounts/[id]/website/[siteId]/build", () => {
  it("the hourly-limit 429 carries Retry-After", async () => {
    mem.seed("subAccounts/sa1/website/site1", { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "draft" });
    mem.seed(websiteLimitsPath("sa1"), { windowStart: Date.now() - 10 * 60_000, count: WEBSITE_BUILDS_PER_HOUR });
    const res = await buildSite(
      new Request("https://app.test/api/sub-accounts/sa1/website/site1/build", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-uid": "u1" },
        body: JSON.stringify({ config: sampleWebsiteConfig() }),
      }),
      { params: Promise.resolve({ id: "sa1", siteId: "site1" }) },
    );
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(49 * 60);
    expect(retryAfter).toBeLessThanOrEqual(50 * 60);
  });
});
