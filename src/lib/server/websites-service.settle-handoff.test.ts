import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";
import type { PollBuildResult } from "@/lib/gitpage/client";
import type { WebsiteDoc } from "@/types/website";

/**
 * The publish hand-off as settleWebsiteBuild runs it: once, for the caller
 * that won the settle claim, after the response, and never able to move the
 * site's build state. The real settle service and the real hand-off service
 * over the in-memory Firestore; `provisionWebsiteHandoff` is wrapped (not
 * replaced) so a test can count calls or make it throw, and only the push
 * sender and the live-URL probe are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "m1" }),
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));
// GitLab's path URL 308s to the project's unique domain, as in production.
const UNIQUE = "https://acme-site-1a2b3c.gitlab.io/";
/** Extra answers a test can add: URL → [status, Location]. */
const routes = vi.hoisted(() => new Map<string, [number, string | null]>());
vi.mock("@/lib/webhooks/public-fetch", () => ({
  publicFetch: async (url: string) =>
    routes.has(url)
      ? new Response(null, { status: routes.get(url)![0], headers: routes.get(url)![1] ? { location: routes.get(url)![1]! } : {} })
      : url === "https://acme.gitlab.io/site"
      ? new Response(null, { status: 308, headers: { location: "https://acme-site-1a2b3c.gitlab.io/" } })
      : url === "https://acme-root.gitlab.io/"
        ? new Response(null, { status: 308 }) // a redirect with no Location: unresolved
        : new Response(null, { status: 200 }),
}));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: async () => undefined }));

const provision = vi.hoisted(() => ({
  spy: null as null | ReturnType<typeof vi.fn>,
}));
vi.mock("@/lib/server/website-handoff-service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/website-handoff-service")>();
  const spy = vi.fn(real.provisionWebsiteHandoff);
  provision.spy = spy;
  return { ...real, provisionWebsiteHandoff: spy };
});

const { settleWebsiteBuild } = await import("./websites-service");
const real = await vi.importActual<typeof import("@/lib/server/website-handoff-service")>(
  "@/lib/server/website-handoff-service",
);
const spy = () => provision.spy!;

const SITE = "subAccounts/sa1/website/site1";
const JOB = "build_abc";

const published: PollBuildResult = {
  status: "Published",
  statusPhase: "completed",
  pagesUrl: "https://acme.gitlab.io/site",
  pagesUrlRefused: null,
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
    kbText: "Acme Plumbing fixes leaks.",
    agentPersona: null,
    theme: { primaryColor: "#B13F2B", conceptName: "Atelier" },
  },
  pageId: "page_42",
};

let formId = "";
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
    formId,
    provisioning: null,
    lastBuildByUid: "u1",
    config: { quality: "premium", heading: "Acme Plumbing", include_form: true, include_chat: true },
    ...patch,
  } as unknown as WebsiteDoc;
  mem.seed(SITE, doc as unknown as Record<string, unknown>);
  return doc;
}

const settle = (site: WebsiteDoc, result: PollBuildResult = published, attempts = 0) =>
  settleWebsiteBuild({ subAccountId: "sa1", siteId: "site1", site, result, attempts });

/** Settle, then let the after-response hand-off finish. */
const settleAndFlush = async (...args: Parameters<typeof settle>) => {
  const outcome = await settle(...args);
  await flushAfterResponse();
  return outcome;
};

const provisioning = () => mem.read(SITE)?.provisioning as Record<string, unknown> | null | undefined;

beforeEach(async () => {
  mem.clear();
  routes.clear();
  spy().mockReset().mockImplementation(real.provisionWebsiteHandoff);
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    name: "Acme",
    websiteEnabledByAgency: true,
    accountContact: { name: "Ann", email: "ann@acme.test", phone: null },
  });
  mem.seed("agencies/ag1", { ownerUid: "u_owner" });
  formId = await real.ensureWebsiteContactForm({ subAccountId: "sa1", createdByUid: "u1" });
});

describe("the hand-off runs once, for the caller that settled the site", () => {
  it("a premium publish runs it and records what it did — the speed-to-lead workflow as a draft", async () => {
    expect(await settleAndFlush(seedSite())).toBe("ready");
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(mem.read(SITE)).toMatchObject({ status: "ready", liveUrl: UNIQUE });
    expect(provisioning()).toMatchObject({
      hostname: "acme-site-1a2b3c.gitlab.io",
      formId,
      chatAllowlisted: true,
      chatEnabled: false,
      workflowStatus: "draft",
      errors: [],
    });
    const workflows = mem.list("workflows");
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({ status: "draft" });
    expect(provisioning()?.workflowId).toBe(workflows[0].id);
  });

  it("the poll tick and the callback racing on the same read: ONE hand-off, from the winner", async () => {
    const site = seedSite();
    const outcomes = await Promise.all([settle(site, published, 0), settle(site, published, 7)]);
    await flushAfterResponse();
    expect([...outcomes].sort()).toEqual(["noop", "ready"]);
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(mem.list("workflows")).toHaveLength(1);
  });

  it("a repeat of the report after the site settled runs nothing", async () => {
    const site = seedSite();
    await settleAndFlush(site);
    expect(await settleAndFlush(site, published, 9)).toBe("noop");
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a failed build", { result: { ...published, status: "failed", pagesUrl: null, error: "boom" } as PollBuildResult }],
    ["a standard (non-premium) build", { site: { quality: "standard" } as Partial<WebsiteDoc> }],
    ["a result for a job the site is no longer chasing", { site: { gitpageJobId: "build_new" } as Partial<WebsiteDoc>, stale: true }],
  ])("%s runs no hand-off", async (_label, c: { result?: PollBuildResult; site?: Partial<WebsiteDoc>; stale?: boolean }) => {
    const seeded = seedSite(c.site ?? {});
    // A stale caller read the doc while it still carried the old job.
    const read = c.stale ? { ...seeded, gitpageJobId: JOB } : seeded;
    await settleAndFlush(read, c.result ?? published);
    expect(spy()).not.toHaveBeenCalled();
    expect(provisioning() ?? null).toBeNull();
    expect(mem.list("workflows")).toEqual([]);
  });
});

describe("an address the walk could not resolve", () => {
  it("is stored as reported, and its host is NOT allow-listed — the summary says why", async () => {
    const unresolved = { ...published, pagesUrl: "https://acme-root.gitlab.io/" };
    expect(await settleAndFlush(seedSite(), unresolved)).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({ liveUrl: "https://acme-root.gitlab.io/" });
    expect(provisioning()).toMatchObject({ hostname: null, chatAllowlisted: false });
    expect(provisioning()?.chatSkippedReason).toContain("did not lead to the site's own host");
    expect(mem.read("subAccounts/sa1/aiAgent/web-chat")?.webChat).toMatchObject({ allowedDomains: [] });
  });
});

describe("a workspace whose website gate is off", () => {
  it("gets its site settled and nothing more: no summary, no chat, no profile, no workflow", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: false });
    expect(await settleAndFlush(seedSite())).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({ status: "ready", liveUrl: UNIQUE });
    expect(provisioning() ?? null).toBeNull();
    expect(mem.read("subAccounts/sa1/aiAgent/web-chat")).toBeUndefined();
    expect(mem.read("subAccounts/sa1/aiAgent/profile")).toBeUndefined();
    expect(mem.list("workflows")).toEqual([]);
  });
});

describe("the hand-off can never move the site's build state", () => {
  it("a hand-off that throws is recorded on the summary; the site stays ready", async () => {
    spy().mockRejectedValueOnce(new Error("chat store down"));
    expect(await settleAndFlush(seedSite())).toBe("ready");
    expect(mem.read(SITE)).toMatchObject({ status: "ready", liveUrl: UNIQUE });
    expect(provisioning()).toMatchObject({ formId, errors: ["chat store down"], workflowId: null });
  });

  it.each([
    ["reset to a draft", { status: "draft", gitpageJobId: null }],
    ["rebuilt as a new job", { status: "queued", gitpageJobId: "build_new" }],
    ["removed", null],
  ])("a site %s while the hand-off ran keeps its new state; the summary is dropped", async (_label, during) => {
    spy().mockImplementationOnce(async (input) => {
      if (during) await mem.db.doc(SITE).update(during);
      else await mem.db.doc(SITE).delete();
      return real.provisionWebsiteHandoff(input);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await settleAndFlush(seedSite());
    error.mockRestore();
    if (during) {
      expect(mem.read(SITE)).toMatchObject(during);
      expect(provisioning() ?? null).toBeNull();
    } else {
      expect(mem.read(SITE)).toBeUndefined();
    }
  });

  it("the summary write touches nothing but the summary", async () => {
    let afterSettle: Record<string, unknown> | undefined;
    spy().mockImplementationOnce(async (input) => {
      afterSettle = mem.read(SITE);
      return real.provisionWebsiteHandoff(input);
    });
    await settleAndFlush(seedSite());
    const { provisioning: written, updatedAt: _u1, ...rest } = mem.read(SITE)!;
    const { provisioning: before, updatedAt: _u2, ...restBefore } = afterSettle!;
    expect(before).toBeNull();
    expect(written).not.toBeNull();
    expect(rest).toEqual(restBefore);
  });
});

describe("the site moving on between the settle and the hand-off (breaker, PR #400)", () => {
  const CHAT = "subAccounts/sa1/aiAgent/web-chat";
  const PROFILE = "subAccounts/sa1/aiAgent/profile";

  it.each([
    ["removed", () => mem.db.doc(SITE).delete()],
    ["rebuilt as a new job", () => mem.db.doc(SITE).update({ status: "queued", gitpageJobId: "build_NEW", liveUrl: null })],
    ["gated off", () => mem.db.doc("subAccounts/sa1").update({ websiteEnabledByAgency: false })],
  ])("site %s right after the settle: the hand-off writes nothing for it", async (_label, move) => {
    expect(await settle(seedSite())).toBe("ready");
    await move();
    await flushAfterResponse();
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(mem.read(CHAT)).toBeUndefined();
    expect(mem.read(PROFILE)).toBeUndefined();
    expect(mem.list("workflows")).toEqual([]);
  });

  it("a refused-address failure, then a good Published, then repeats of both: ONE hand-off", async () => {
    const site = seedSite();
    expect(await settleAndFlush(site, { ...published, pagesUrl: null, pagesUrlRefused: "http://x" })).toBe("failed");
    const failedSite = mem.read(SITE) as unknown as WebsiteDoc;
    expect(await settleAndFlush(failedSite)).toBe("ready");
    expect(await settleAndFlush(mem.read(SITE) as unknown as WebsiteDoc)).toBe("noop");
    expect(await settleAndFlush(failedSite)).toBe("noop");
    expect(spy()).toHaveBeenCalledTimes(1);
  });

  it("three settles at once (tick, callback, re-check) on one read: ONE hand-off", async () => {
    const site = seedSite();
    const outs = await Promise.all([settle(site), settle(site), settle(site, published, 9)]);
    await flushAfterResponse();
    expect(outs.filter((o) => o === "ready")).toHaveLength(1);
    expect(spy()).toHaveBeenCalledTimes(1);
  });
});

describe("which host a published site gets allow-listed, end to end (breaker round 2, PR #400)", () => {
  const NS = "https://gitpage-ns.gitlab.io/acme-site";
  const allowedAfter = async (pagesUrl: string) => {
    expect(await settleAndFlush(seedSite(), { ...published, pagesUrl })).toBe("ready");
    return (mem.read("subAccounts/sa1/aiAgent/web-chat")?.webChat as { allowedDomains: string[] }).allowedDomains;
  };

  it("N1: a trailing-dot report cannot widen to the whole TLD", async () => {
    routes.set("https://acme.com./", [308, "https://attacker.com./"]);
    expect(await allowedAfter("https://acme.com./")).not.toContain("attacker.com");
  });

  it("N2: acme.co.za cannot redirect to another .co.za site", async () => {
    routes.set("https://acme.co.za/", [308, "https://evil.co.za/"]);
    expect(await allowedAfter("https://acme.co.za/")).not.toContain("evil.co.za");
  });

  it("N4a: the namespace root reported as-is is not allow-listed", async () => {
    expect(await allowedAfter("https://gitpage-ns.gitlab.io/")).toEqual([]);
  });

  it("N4b: a path URL redirecting to the namespace root is not allow-listed", async () => {
    routes.set(NS, [308, "/"]);
    expect(await allowedAfter(NS)).toEqual([]);
  });

  it("N6: the unique domain landed on under a path is allow-listed", async () => {
    routes.set(NS, [308, "https://acme-site-1a2b3c.gitlab.io/index.html"]);
    expect(await allowedAfter(NS)).toEqual(["acme-site-1a2b3c.gitlab.io"]);
    expect(mem.read(SITE)?.liveUrl).toBe("https://acme-site-1a2b3c.gitlab.io/index.html");
  });

  it("a www custom domain that redirects to its apex resolves and is allow-listed", async () => {
    routes.set("https://www.acme.co.za/", [301, "https://acme.co.za/"]);
    expect(await allowedAfter("https://www.acme.co.za/")).toEqual(["acme.co.za"]);
  });
});
