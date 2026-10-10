import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import type { PollBuildResult } from "@/lib/gitpage/client";
import type { WebsiteDoc } from "@/types/website";

/**
 * settleWebsiteBuild is the ONE terminal handler for a gitpage build: the
 * QStash poll tick, the manual Re-check and the `build.settled` callback all
 * end here. The callback and a poll tick can both read "building" before
 * either writes, so the terminal write claims the doc in a transaction and
 * the loser no-ops — the premium hand-off (WS-3) must not run twice for one
 * publish. Real service over the in-memory Firestore, whose transactions
 * re-run on contention as Firestore's do.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "m1" }),
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const { settleWebsiteBuild } = await import("./websites-service");

const SITE = "subAccounts/sa1/website/site1";
const JOB = "build_abc";

const published: PollBuildResult = {
  status: "Published",
  statusPhase: "completed",
  pagesUrl: "https://acme.gitlab.io/site",
  repoUrl: null,
  error: null,
  partialErrors: null,
  isTerminal: true,
  updatedAt: null,
  premium: {
    quality: "premium",
    concept: "atelier",
    estimatedDurationSeconds: 1200,
    failedStage: null,
    imageProvider: null,
    imageCount: null,
    briefSource: null,
    kbText: null,
    agentPersona: null,
    theme: { primaryColor: "#B13F2B", conceptName: "Atelier" },
  },
  pageId: "page_42",
};

const failed: PollBuildResult = {
  ...published,
  status: "failed",
  statusPhase: "images",
  pagesUrl: null,
  error: "Image generation failed.",
  premium: { ...published.premium!, failedStage: "images", theme: null },
  pageId: null,
};

function seedSite(patch: Partial<WebsiteDoc> = {}): WebsiteDoc {
  const doc = {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    name: "Acme",
    status: "building",
    gitpageJobId: JOB,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 3,
    quality: "premium",
    ...patch,
  } as WebsiteDoc;
  mem.seed(SITE, doc as unknown as Record<string, unknown>);
  return doc;
}

const settle = (site: WebsiteDoc, result: PollBuildResult, attempts: number) =>
  settleWebsiteBuild({ subAccountId: "sa1", siteId: "site1", site, result, attempts });

beforeEach(() => mem.clear());

describe("settleWebsiteBuild", () => {
  it("settles a Published build as ready with the v2 fields", async () => {
    const site = seedSite();
    expect(await settle(site, published, 4)).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({
      status: "ready",
      liveUrl: "https://acme.gitlab.io/site",
      errorMessage: null,
      statusPhase: "completed",
      conceptName: "Atelier",
      gitpagePageId: "page_42",
      pollAttempts: 4,
    });
  });

  it("settles a failed build with gitpage's error and the stage it failed at", async () => {
    const site = seedSite();
    expect(await settle(site, failed, 4)).toBe("failed");
    expect(mem.read(SITE)).toMatchObject({
      status: "failed",
      errorMessage: "Image generation failed.",
      statusPhase: "images",
      liveUrl: null,
      pollAttempts: 4,
    });
  });

  it("settles once when the poll tick and the callback race on the same read", async () => {
    // Both callers read the doc while it was still building.
    const site = seedSite();
    const outcomes = await Promise.all([
      settle(site, published, 0), // the callback
      settle(site, published, 7), // the poll tick
    ]);
    expect([...outcomes].sort()).toEqual(["noop", "ready"]);
    // The loser wrote nothing: the doc carries the winner's attempt count.
    const winnerAttempts = outcomes[0] === "ready" ? 0 : 7;
    expect(mem.read(SITE)).toMatchObject({ status: "ready", pollAttempts: winnerAttempts });
  });

  it("is a no-op the second time, leaving the settled doc untouched", async () => {
    const site = seedSite();
    expect(await settle(site, published, 4)).toBe("ready");
    const settled = mem.read(SITE);
    expect(await settle(site, published, 9)).toBe("noop");
    expect(mem.read(SITE)).toEqual(settled);
  });

  it("never turns a ready site into failed on a late failure report", async () => {
    const site = seedSite();
    await settle(site, published, 4);
    expect(await settle(site, failed, 5)).toBe("noop");
    expect(mem.read(SITE)).toMatchObject({ status: "ready", liveUrl: "https://acme.gitlab.io/site" });
  });

  it("ignores a result for a job the site is no longer chasing", async () => {
    // The operator rebuilt between the caller's read and its settle.
    const site = seedSite();
    mem.seed(SITE, { ...site, gitpageJobId: "build_newer", status: "queued" });
    expect(await settle(site, published, 4)).toBe("noop");
    expect(mem.read(SITE)).toMatchObject({ status: "queued", gitpageJobId: "build_newer", liveUrl: null });
  });

  it("ignores a result for a site that was removed", async () => {
    const site = seedSite();
    await mem.db.doc(SITE).delete();
    expect(await settle(site, published, 4)).toBe("noop");
    expect(mem.read(SITE)).toBeUndefined();
  });

  it("lets a manual re-check resurrect a site the poll cap settled as failed", async () => {
    const site = seedSite({ status: "failed", errorMessage: "Build is taking longer than expected" });
    expect(await settle(site, published, 45)).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({ status: "ready", errorMessage: null });
  });

  it("lets a late Published callback win over a poll-cap failure written after its read", async () => {
    const site = seedSite();
    mem.seed(SITE, { ...site, status: "failed", errorMessage: "Build is taking longer than expected" });
    expect(await settle(site, published, 0)).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({ status: "ready", errorMessage: null });
  });

  it("does not rewrite a failed site when a caller that read it building also reports failed", async () => {
    const site = seedSite();
    mem.seed(SITE, { ...site, status: "failed", errorMessage: "first report" });
    expect(await settle(site, failed, 4)).toBe("noop");
    expect(mem.read(SITE)).toMatchObject({ status: "failed", errorMessage: "first report" });
  });

  it("R4: does not settle Published without a live URL — a site is never ready with no address", async () => {
    const site = seedSite();
    const before = mem.read(SITE);
    expect(await settle(site, { ...published, pagesUrl: null }, 4)).toBe("noop");
    expect(mem.read(SITE)).toEqual(before);
  });

  it("R13: records the report it applied and ignores a repeat of it", async () => {
    const site = seedSite();
    expect(await settle(site, failed, 4)).toBe("failed");
    expect(mem.read(SITE)?.settledDelivery).toEqual({ jobId: JOB, status: "failed" });

    // The operator resumed the build; the same failure report arrives again.
    await mem.db.doc(SITE).update({ status: "building", errorMessage: null });
    const resumed = mem.read(SITE);
    expect(await settle(site, failed, 9)).toBe("noop");
    expect(mem.read(SITE)).toEqual(resumed);

    // Published for the same job is a different report, and lands.
    expect(await settle(site, published, 9)).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({ status: "ready", settledDelivery: { jobId: JOB, status: "Published" } });
  });

  it("does nothing for a site with no job id", async () => {
    const site = seedSite({ gitpageJobId: null });
    const before = mem.read(SITE);
    expect(await settle(site, published, 4)).toBe("noop");
    expect(mem.read(SITE)).toEqual(before);
  });
});
