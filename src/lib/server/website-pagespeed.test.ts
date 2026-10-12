import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { PollBuildResult } from "@/lib/gitpage/client";
import type { WebsiteDoc } from "@/types/website";

/**
 * The post-publish PageSpeed check: what is measured (the address visitors
 * use), where the result lands (only the build that was measured), and that
 * the settle schedules it once per published job. Real runner and real
 * settle over the in-memory Firestore; Google's answer and the QStash
 * publish are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const qstash = vi.hoisted(() => ({ configured: true, publishCallback: vi.fn() }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => qstash.configured,
  publishCallback: qstash.publishCallback,
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.stubEnv("PAGESPEED_API_KEY", "");

const { runPageSpeed } = await import("./website-pagespeed");
const { settleWebsiteBuild, websitePageSpeedPath } = await import("./websites-service");

const SITE = "subAccounts/sa1/website/site1";
const LIVE = "https://acme.gitlab.io/site";

const PSI_OK = {
  lighthouseResult: {
    categories: { performance: { score: 0.5 }, seo: { score: 0.99 }, accessibility: { score: 1 }, "best-practices": { score: 0.8 } },
  },
};

function seedSite(patch: Partial<WebsiteDoc> = {}) {
  mem.seed(SITE, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "ready",
    gitpageJobId: "build_abc",
    liveUrl: LIVE,
    customDomain: null,
    ...patch,
  } as unknown as Record<string, unknown>);
}

/** The PSI query of the n-th fetch. */
const psiQuery = (n = 0) => new URL(String(fetchMock.mock.calls[n]?.[0])).searchParams;

beforeEach(() => {
  mem.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json(PSI_OK));
  qstash.configured = true;
  qstash.publishCallback.mockReset();
  qstash.publishCallback.mockResolvedValue({ messageId: "m1" });
  vi.stubEnv("PAGESPEED_API_KEY", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runPageSpeed", () => {
  it("measures the live URL on Google's PSI endpoint, mobile, and stores the scores on the site", async () => {
    seedSite();
    const result = await runPageSpeed("sa1", "site1");
    expect(result).toMatchObject({ url: LIVE, performance: 50, seo: 99, accessibility: 100, bestPractices: 80, error: null });
    const called = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(called.origin + called.pathname).toBe("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    expect(psiQuery().get("url")).toBe(LIVE);
    expect(psiQuery().get("strategy")).toBe("mobile");
    expect(psiQuery().has("key")).toBe(false);
    expect(mem.read(SITE)?.pagespeed).toMatchObject({ url: LIVE, performance: 50 });
  });

  it("measures the custom domain when there is one, and sends the API key when set", async () => {
    seedSite({ customDomain: "www.acme.com" });
    vi.stubEnv("PAGESPEED_API_KEY", "psi_key");
    await runPageSpeed("sa1", "site1");
    expect(psiQuery().get("url")).toBe("https://www.acme.com/");
    expect(psiQuery().get("key")).toBe("psi_key");
  });

  it("stores Google's error rather than throwing, and names the missing key on a keyless 429", async () => {
    seedSite();
    fetchMock.mockImplementation(async () => Response.json({ error: { message: "Lighthouse returned error: NO_FCP" } }, { status: 500 }));
    expect(await runPageSpeed("sa1", "site1")).toMatchObject({ performance: null, error: "Lighthouse returned error: NO_FCP" });
    fetchMock.mockImplementation(async () => Response.json({}, { status: 429 }));
    const quota = await runPageSpeed("sa1", "site1");
    expect(quota?.error).toMatch(/PAGESPEED_API_KEY/);
    expect(mem.read(SITE)?.pagespeed).toMatchObject({ error: quota?.error });
  });

  it.each([
    ["not live", { status: "building" }],
    ["owned by another sub-account", { subAccountId: "sa2" }],
    ["live at a non-https address", { liveUrl: "http://acme.example/" }],
  ] as const)("does nothing for a site %s", async (_label, patch) => {
    seedSite(patch as Partial<WebsiteDoc>);
    expect(await runPageSpeed("sa1", "site1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SITE)?.pagespeed).toBeUndefined();
  });

  it.each([
    ["rebuilt", { status: "queued", gitpageJobId: "build_new" }],
    ["rebuilt and live again at the same address", { gitpageJobId: "build_new" }],
    ["marked failed", { status: "failed" }],
    ["reset", { status: "draft", gitpageJobId: null, liveUrl: null }],
    ["given a custom domain", { customDomain: "www.acme.com" }],
  ])("does not write the scores onto a site %s while Google was measuring", async (_label, change) => {
    seedSite();
    fetchMock.mockImplementation(async () => {
      mem.seed(SITE, { ...mem.read(SITE), ...change });
      return Response.json(PSI_OK);
    });
    expect(await runPageSpeed("sa1", "site1")).toBeNull();
    expect(mem.read(SITE)?.pagespeed).toBeUndefined();
  });
});

describe("settleWebsiteBuild schedules the check", () => {
  const published: PollBuildResult = {
    status: "Published",
    statusPhase: "completed",
    pagesUrl: LIVE,
    pagesUrlRefused: null,
    repoUrl: null,
    error: null,
    partialErrors: null,
    isTerminal: true,
    updatedAt: null,
    premium: null,
    pageId: null,
  };
  const settle = (result: PollBuildResult) => {
    seedSite({ status: "building", liveUrl: null, quality: "standard" } as Partial<WebsiteDoc>);
    return settleWebsiteBuild({
      subAccountId: "sa1",
      siteId: "site1",
      site: mem.read(SITE) as unknown as WebsiteDoc,
      result,
      attempts: 3,
    });
  };
  const pagespeedCalls = () =>
    qstash.publishCallback.mock.calls.filter(([input]) => String(input.pathname).endsWith("/pagespeed"));

  it("once per published job, two minutes out, to the path the route binds its signature to", async () => {
    expect(await settle(published)).toBe("ready");
    expect(pagespeedCalls()).toEqual([
      [
        {
          pathname: websitePageSpeedPath("sa1", "site1"),
          body: { subAccountId: "sa1", siteId: "site1" },
          delaySeconds: 120,
          deduplicationId: "pagespeed_sa1_site1_build_abc",
        },
      ],
    ]);
    expect(websitePageSpeedPath("sa1", "site1")).toBe("/api/sub-accounts/sa1/website/site1/pagespeed");
  });

  it("not for a failed build, a settle that lost, or with QStash unset", async () => {
    expect(await settle({ ...published, status: "failed", pagesUrl: null, error: "boom" })).toBe("failed");
    seedSite({ status: "ready" });
    expect(
      await settleWebsiteBuild({ subAccountId: "sa1", siteId: "site1", site: mem.read(SITE) as unknown as WebsiteDoc, result: published, attempts: 1 }),
    ).toBe("noop");
    qstash.configured = false;
    expect(await settle(published)).toBe("ready");
    expect(pagespeedCalls()).toEqual([]);
  });
});
