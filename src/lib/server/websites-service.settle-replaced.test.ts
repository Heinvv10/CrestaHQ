import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";
import type { PollBuildResult } from "@/lib/gitpage/client";
import { blankWebsiteConfig, type WebsiteDoc } from "@/types/website";

/**
 * A rebuild makes a new gitpage site; once it publishes, settleWebsiteBuild
 * hides the one it replaces in gitpage (LeadStack 1.0.42) — once, after the
 * response, never when the "new" site is the old one, and never failing the
 * publish. A site from a standard Agency template gets no premium hand-off.
 * Real settle service + real gitpage client over the in-memory Firestore;
 * `provisionWebsiteHandoff` is wrapped so a test can count it, and only the
 * outbound fetch and the live-URL probe are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => false, publishCallback: async () => null }));
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch: async () => new Response(null, { status: 200 }) }));
const provision = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock("@/lib/server/website-handoff-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/website-handoff-service")>();
  provision.spy.mockImplementation(async () => null);
  return { ...real, provisionWebsiteHandoff: provision.spy };
});

const { settleWebsiteBuild } = await import("./websites-service");

const SITE = "subAccounts/sa1/website/site1";
const OLD = "64b7f0c2a1d3e4f5a6b7c8d9";
const NEW = "64b7f0c2a1d3e4f5a6b7c8da";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };

const published = (patch: Partial<PollBuildResult> = {}): PollBuildResult => ({
  status: "Published",
  statusPhase: "completed",
  pagesUrl: "https://acme.gitlab.io/site",
  pagesUrlRefused: null,
  repoUrl: null,
  error: null,
  partialErrors: null,
  isTerminal: true,
  updatedAt: null,
  premium: null,
  pageId: NEW,
  ...patch,
});

function seedSite(patch: Partial<WebsiteDoc> = {}): WebsiteDoc {
  const doc = {
    id: "site1", agencyId: "ag1", subAccountId: "sa1", name: "Acme", status: "building",
    gitpageJobId: "job1", liveUrl: null, quality: "premium", replacesGitpagePageId: OLD,
    config: blankWebsiteConfig(), ...patch,
  } as WebsiteDoc;
  mem.seed(SITE, doc as unknown as Record<string, unknown>);
  return doc;
}
const settle = (site: WebsiteDoc, result: PollBuildResult) =>
  settleWebsiteBuild({ subAccountId: "sa1", siteId: "site1", site, result, attempts: 2 });
const hides = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/sites"));

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true });
  provision.spy.mockClear();
  fetchMock.mockReset().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("settleWebsiteBuild — the replaced gitpage site", () => {
  it("hides the replaced site once, after the response, and forgets it on the doc", async () => {
    const site = seedSite();
    expect(await settle(site, published())).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({ status: "ready", gitpagePageId: NEW, replacesGitpagePageId: null });
    await flushAfterResponse();
    expect(hides()).toHaveLength(1);
    const [, init] = hides()[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ action: "hide", pageId: OLD, subAccountId: "sa1", reason: "replaced" });
    // A replayed report is a no-op: nothing is hidden twice.
    expect(await settle(site, published())).toBe("noop");
    await flushAfterResponse();
    expect(hides()).toHaveLength(1);
  });

  it("does not hide anything when the published site is the one recorded as replaced", async () => {
    const site = seedSite({ replacesGitpagePageId: NEW });
    expect(await settle(site, published())).toBe("ready");
    await flushAfterResponse();
    expect(hides()).toHaveLength(0);
  });

  it("a gitpage failure hiding it does not fail the publish", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "nope" }, { status: 500 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const site = seedSite();
    expect(await settle(site, published())).toBe("ready");
    await flushAfterResponse();
    expect(hides()).toHaveLength(1);
    expect(mem.read(SITE)).toMatchObject({ status: "ready", liveUrl: "https://acme.gitlab.io/site" });
    expect(errors.mock.calls.flat().join(" ")).toContain("could not hide the replaced site");
    errors.mockRestore();
  });

  it("a failed rebuild keeps the replaced site recorded and hides nothing", async () => {
    const site = seedSite();
    expect(await settle(site, published({ status: "failed", pagesUrl: null, error: "Missing businessPhone" }))).toBe("failed");
    await flushAfterResponse();
    expect(hides()).toHaveLength(0);
    expect(mem.read(SITE)).toMatchObject({ status: "failed", replacesGitpagePageId: OLD, errorMessage: "Missing businessPhone" });
  });
});

describe("settleWebsiteBuild — template builds", () => {
  const tplConfig = { ...blankWebsiteConfig(), template_id: OLD };

  it("a failure names gitpage's fields with the wizard's labels", async () => {
    const site = seedSite({ config: tplConfig });
    await settle(site, published({ status: "failed", pagesUrl: null, error: "Missing businessPhone and ctaLink" }));
    expect(mem.read(SITE)?.errorMessage).toBe("Missing Phone and Main button link");
  });

  it("a standard template (gitpage reports no premium block) gets no premium hand-off; a premium one does", async () => {
    await settle(seedSite({ config: tplConfig }), published());
    await flushAfterResponse();
    expect(provision.spy).not.toHaveBeenCalled();
    await settle(seedSite({ config: tplConfig, gitpageJobId: "job2" }), published({ premium: { quality: "premium" } as PollBuildResult["premium"] }));
    await flushAfterResponse();
    expect(provision.spy).toHaveBeenCalledTimes(1);
  });
});
