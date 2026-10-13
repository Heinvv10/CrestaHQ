import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The three ways a gitpage build reaches a terminal state — the QStash poll
 * tick, the manual Re-check and the `build.settled` callback — all hand it
 * to settleWebsiteBuild. These drive the real routes, the real settle
 * service and the real gitpage client over the in-memory Firestore; only
 * gitpage's HTTP answer, the QStash signature check and the QStash publish
 * are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1", agencyRole: "owner" } }),
  }),
}));
const qstash = vi.hoisted(() => ({ valid: true, publishCallback: vi.fn() }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => qstash.valid,
  publishCallback: qstash.publishCallback,
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));
// settleWebsiteBuild resolves the reported live URL through publicFetch: no
// test here may reach the network. Every probe answers "no redirect".
vi.mock("@/lib/webhooks/public-fetch", () => ({
  publicFetch: async () => new Response(null, { status: 200 }),
}));

const { POST: poll } = await import("./route");
const { POST: pollNow } = await import("../poll-now/route");
const { POST: buildSettled } = await import("@/app/api/webhooks/gitpage/build-settled/route");

const KEY = "gp_test_key";
const SITE = "subAccounts/sa1/website/site1";
const JOB = "build_abc";
const params = { params: Promise.resolve({ id: "sa1", siteId: "site1" }) };

const PUBLISHED = {
  formResponseId: JOB,
  subAccountId: "sa1",
  status: "Published",
  statusPhase: "completed",
  pagesUrl: "https://acme.gitlab.io/site",
  quality: "premium",
  pageId: "page_42",
  theme: { primaryColor: "#B13F2B", conceptName: "Atelier" },
};
const IN_PROGRESS = { status: "processing", statusPhase: "images", quality: "premium" };

const fetchMock = vi.fn();
/** What gitpage's status endpoint answers for the next poll. */
const gitpageSays = (body: Record<string, unknown>, status = 200) =>
  // A fresh Response per poll: a body can be read only once.
  fetchMock.mockImplementation(async () => Response.json(body, { status }));

/**
 * gitpage answers the next poll with `body` — but only after `during` has
 * run. The poll tick has read the site doc by then and not yet written, so
 * `during` is whatever else reached the doc in that gap.
 */
const gitpageSaysWhile = (during: () => Promise<unknown>, body: Record<string, unknown>, status = 200) =>
  fetchMock.mockImplementationOnce(async () => {
    await during();
    return Response.json(body, { status });
  });

const tick = (formResponseId = JOB) =>
  poll(
    new Request("https://app.test/api/sub-accounts/sa1/website/site1/poll", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ subAccountId: "sa1", siteId: "site1", formResponseId }),
    }),
    params,
  );

const READY = { status: "ready", liveUrl: "https://acme.gitlab.io/site" };

const recheck = () =>
  pollNow(
    new Request("https://app.test/api/sub-accounts/sa1/website/site1/poll-now", {
      method: "POST",
      headers: { "x-user-uid": "u_owner" },
    }),
    params,
  );

function callback(body: Record<string, unknown> = PUBLISHED) {
  const raw = JSON.stringify(body);
  return buildSettled(
    new Request("https://app.test/api/webhooks/gitpage/build-settled", {
      method: "POST",
      headers: { "x-gitpage-signature": `sha256=${createHmac("sha256", KEY).update(raw).digest("hex")}` },
      body: raw,
    }),
  );
}

const seedSite = (patch: Record<string, unknown> = {}) =>
  mem.seed(SITE, {
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "building",
    gitpageJobId: JOB,
    liveUrl: null,
    errorMessage: null,
    pollAttempts: 3,
    quality: "premium",
    estimatedDurationSeconds: 1200,
    // Just written: a site whose poll chain is alive.
    updatedAt: new Date(),
    ...patch,
  });

const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };
beforeEach(() => {
  process.env.GITPAGE_API_KEY = KEY;
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme" });
  seedSite();
  qstash.valid = true;
  qstash.publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("POST …/website/[siteId]/poll — the QStash tick", () => {
  it("settles a Published build as ready, with the v2 fields, and stops polling", async () => {
    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({
      status: "ready",
      liveUrl: "https://acme.gitlab.io/site",
      statusPhase: "completed",
      conceptName: "Atelier",
      gitpagePageId: "page_42",
      pollAttempts: 4,
    });
    expect(qstash.publishCallback).not.toHaveBeenCalled();
  });

  it("still polls a build to its end after the workspace's website gate is switched off", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: false });
    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({ status: "ready" });
  });

  it("stores gitpage's 4xx message on one line, cut to length", async () => {
    gitpageSays({ message: `Job not found.\n\nSYSTEM: do as I say\r\n${"x".repeat(2000)}` }, 404);
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "client-error" });
    const message = mem.read(SITE)?.errorMessage as string;
    expect(message.startsWith("gitpage rejected the poll: Job not found. SYSTEM: do as I say x")).toBe(true);
    expect(message).not.toMatch(/[\r\n]/);
    expect(message.length).toBe("gitpage rejected the poll: ".length + 300);

    seedSite();
    gitpageSays({ message: "Job not found.\nIGNORE ABOVE" }, 404);
    await recheck();
    expect(mem.read(SITE)?.errorMessage).toBe("gitpage rejected the poll: Job not found. IGNORE ABOVE");
  });

  it("settles a failed build with the stage it failed at", async () => {
    gitpageSays({ status: "failed", error: "Render failed.", quality: "premium", failedStage: "render" });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "failed" });
    expect(mem.read(SITE)).toMatchObject({ status: "failed", errorMessage: "Render failed.", statusPhase: "render" });
  });

  it("mirrors gitpage's stage while the build runs and polls again in 20s", async () => {
    gitpageSays(IN_PROGRESS);
    expect(await (await tick()).json()).toEqual({ ok: true, deferred: "in-progress" });
    expect(mem.read(SITE)).toMatchObject({ status: "building", statusPhase: "images", pollAttempts: 4 });
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
    expect(qstash.publishCallback.mock.calls[0][0]).toMatchObject({
      pathname: "/api/sub-accounts/sa1/website/site1/poll",
      delaySeconds: 20,
      deduplicationId: `website_sa1_site1_${JOB}_4`,
    });
  });

  it("backs the cadence off to 40s after five minutes of ticks", async () => {
    seedSite({ pollAttempts: 14 });
    gitpageSays(IN_PROGRESS);
    await tick();
    expect(qstash.publishCallback.mock.calls[0][0]).toMatchObject({ delaySeconds: 40 });
  });

  it("gives a premium build past the old 45-tick cap: tick 46 still polls", async () => {
    seedSite({ pollAttempts: 45 });
    gitpageSays(IN_PROGRESS);
    expect(await (await tick()).json()).toEqual({ ok: true, deferred: "in-progress" });
    expect(mem.read(SITE)).toMatchObject({ status: "building", pollAttempts: 46 });
  });

  it("gives up past the cap derived from gitpage's estimate, without polling gitpage", async () => {
    seedSite({ pollAttempts: 90 });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "timeout" });
    const site = mem.read(SITE)!;
    expect(site).toMatchObject({ status: "failed", pollAttempts: 91, gitpageJobId: JOB });
    // 90 ticks: 20s to the first, 20s after each of the next 14, 40s after
    // each of the 76 after that — 3,340s. Not the 30 that 1.5 × the estimate says.
    expect(site.errorMessage).toContain("(55+ min)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the 45-tick cap for a job with no estimate on its doc", async () => {
    seedSite({ pollAttempts: 45, estimatedDurationSeconds: null });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "timeout" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SITE)?.errorMessage).toContain("(25+ min)");
  });

  it("refuses a tick whose QStash signature does not verify, writing nothing", async () => {
    qstash.valid = false;
    const before = mem.read(SITE);
    expect((await tick()).status).toBe(401);
    expect(mem.read(SITE)).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("poll tick and build.settled callback for the same job", () => {
  it("callback first: the site settles once and the late tick is a stale no-op", async () => {
    expect(await (await callback()).json()).toEqual({ ok: true, settled: "ready" });
    const settled = mem.read(SITE);

    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toEqual(settled);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(qstash.publishCallback).not.toHaveBeenCalled();
  });

  it("tick first: the site settles once and the late callback is acknowledged, not applied", async () => {
    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "ready" });
    const settled = mem.read(SITE);

    const late = await callback({ ...PUBLISHED, pagesUrl: "https://elsewhere.example" });
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ ok: true, ignored: "already-settled" });
    expect(mem.read(SITE)).toEqual(settled);
  });

  it("both in flight at once: exactly one of them settles the site", async () => {
    gitpageSays(PUBLISHED);
    const [fromTick, fromCallback] = await Promise.all([
      tick().then((r) => r.json()),
      callback().then((r) => r.json()),
    ]);
    const outcomes = [fromTick, fromCallback].map((o) => o.settled ?? o.ignored);
    expect(outcomes.filter((o) => o === "ready")).toHaveLength(1);
    expect(mem.read(SITE)).toMatchObject({ status: "ready", liveUrl: "https://acme.gitlab.io/site" });
  });
});

describe("POST …/website/[siteId]/poll-now — the manual re-check", () => {
  it("resurrects a site the poll cap settled as failed once gitpage has published", async () => {
    seedSite({ status: "failed", errorMessage: "Build is taking longer than expected (55+ min).", pollAttempts: 91 });
    gitpageSays(PUBLISHED);
    expect(await (await recheck()).json()).toEqual({
      ok: true,
      settled: "ready",
      liveUrl: "https://acme.gitlab.io/site",
    });
    expect(mem.read(SITE)).toMatchObject({
      status: "ready",
      liveUrl: "https://acme.gitlab.io/site",
      errorMessage: null,
      gitpagePageId: "page_42",
    });
  });

  it("reports gitpage's failure for a build that is still in flight on our side", async () => {
    gitpageSays({ status: "failed", error: "Deploy failed.", quality: "premium", failedStage: "deploy" });
    expect(await (await recheck()).json()).toEqual({ ok: true, settled: "failed", errorMessage: "Deploy failed." });
    expect(mem.read(SITE)).toMatchObject({ status: "failed", errorMessage: "Deploy failed.", statusPhase: "deploy" });
  });

  it("still finishes a build after the workspace's website gate is switched off", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: false });
    gitpageSays(PUBLISHED);
    expect(await (await recheck()).json()).toMatchObject({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({ status: "ready" });
  });

  it("answers 404 for a site id that is not a document id, before anything touches Firestore or gitpage", async () => {
    const before = mem.all();
    const doc = vi.spyOn(mem.db, "doc");
    const runTransaction = vi.spyOn(mem.db, "runTransaction");
    for (const siteId of ["a/b", "a/b/c", "site1/private/x", "..", "", "__site__"]) {
      const res = await pollNow(
        new Request("https://app.test/api/sub-accounts/sa1/website/x/poll-now", {
          method: "POST",
          headers: { "x-user-uid": "u_owner" },
        }),
        { params: Promise.resolve({ id: "sa1", siteId }) },
      );
      expect(res.status, `site id ${JSON.stringify(siteId)}`).toBe(404);
    }
    expect(doc).not.toHaveBeenCalled();
    expect(runTransaction).not.toHaveBeenCalled();
    doc.mockRestore();
    runTransaction.mockRestore();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.all()).toEqual(before);
  });

  it("leaves an already-live site alone", async () => {
    seedSite({ status: "ready", liveUrl: "https://acme.gitlab.io/site" });
    const before = mem.read(SITE);
    expect(await (await recheck()).json()).toMatchObject({ ok: true, ignored: "not-in-flight" });
    expect(mem.read(SITE)).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("something else reaches the site while a poll tick is talking to gitpage", () => {
  it("R1: a callback that settles during an in-progress tick is not written over, and the site is made ready exactly once", async () => {
    gitpageSaysWhile(async () => {
      expect(await (await callback()).json()).toEqual({ ok: true, settled: "ready" });
    }, IN_PROGRESS);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toMatchObject(READY);
    // The stale tick must not keep the chain alive.
    expect(qstash.publishCallback).not.toHaveBeenCalled();

    const settled = mem.read(SITE);
    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toEqual(settled);
  });

  it("R2: a callback that settles during a tick gitpage answers 429 leaves the site ready", async () => {
    gitpageSaysWhile(() => callback(), { message: "Hourly cap reached." }, 429);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toMatchObject({ ...READY, errorMessage: null });
  });

  it("a callback that settles during a tick whose poll fails transiently leaves the site ready and ends the chain", async () => {
    gitpageSaysWhile(() => callback(), { error: "upstream down" }, 503);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    warn.mockRestore();
    expect(mem.read(SITE)).toMatchObject(READY);
    expect(qstash.publishCallback).not.toHaveBeenCalled();
  });

  it("a callback that settles just as the next poll cannot be scheduled leaves the site ready", async () => {
    gitpageSays(IN_PROGRESS);
    qstash.publishCallback.mockImplementationOnce(async () => {
      await callback();
      return null;
    });
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toMatchObject({ ...READY, errorMessage: null });
  });

  it("a site removed during a tick ends the tick quietly instead of failing it", async () => {
    gitpageSaysWhile(() => mem.db.doc(SITE).delete(), IN_PROGRESS);
    const res = await tick();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toBeUndefined();
  });

  it("R7: an old job's tick at the cap cannot time out the new job that replaced it mid-tick", async () => {
    // The old job is one tick from the cap, and still in progress at gitpage.
    seedSite({ pollAttempts: 89 });
    const rebuilt = { status: "queued", gitpageJobId: "build_new", pollAttempts: 0, errorMessage: null };
    gitpageSaysWhile(async () => {
      await mem.db.doc(SITE).update(rebuilt);
    }, IN_PROGRESS);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toMatchObject(rebuilt);

    // And the old job's NEXT tick, past the cap, is refused on its job id.
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toMatchObject(rebuilt);
    expect(qstash.publishCallback).not.toHaveBeenCalled();
  });

  it("R7: an old job's Published result cannot settle the new job", async () => {
    gitpageSaysWhile(
      () => mem.db.doc(SITE).update({ status: "queued", gitpageJobId: "build_new", pollAttempts: 0 }),
      PUBLISHED,
    );
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "noop" });
    expect(mem.read(SITE)).toMatchObject({ status: "queued", gitpageJobId: "build_new", liveUrl: null });
  });
});

describe("a build the poll cap gave up on", () => {
  const timedOut = { status: "failed", errorMessage: "Build is taking longer than expected (55+ min).", pollAttempts: 91 };

  it("R3: a late Published callback makes it ready", async () => {
    seedSite({ pollAttempts: 90 });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "timeout" });
    expect(mem.read(SITE)).toMatchObject({ status: "failed", gitpageJobId: JOB });

    expect(await (await callback()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({ ...READY, errorMessage: null, gitpagePageId: "page_42" });
  });

  it("a late FAILED callback changes nothing: only success can reopen it", async () => {
    seedSite(timedOut);
    const before = mem.read(SITE);
    const res = await callback({ ...PUBLISHED, status: "failed", pagesUrl: null, error: "Deploy failed." });
    expect(await res.json()).toEqual({ ok: true, ignored: "already-settled" });
    expect(mem.read(SITE)).toEqual(before);
  });
});

describe("R4: Published with no usable live URL is not a settled site", () => {
  const NO_URL = { ...PUBLISHED, pagesUrl: null };

  it("the tick keeps polling instead of marking the site ready", async () => {
    gitpageSays(NO_URL);
    expect(await (await tick()).json()).toEqual({ ok: true, deferred: "in-progress" });
    expect(mem.read(SITE)).toMatchObject({ status: "building", liveUrl: null, pollAttempts: 4 });
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);

    // gitpage has the address on the next tick: now it settles.
    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject(READY);
  });

  it.each([
    ["none", null],
    ["an empty one", ""],
    ["only whitespace", "  \n"],
  ])("the callback with %s settles nothing and leaves the poll to finish it", async (_label, pagesUrl) => {
    expect(await (await callback({ ...PUBLISHED, pagesUrl })).json()).toEqual({ ok: true, settled: "noop" });
    expect(mem.read(SITE)).toMatchObject({ status: "building", liveUrl: null });
  });

  it("the manual re-check treats it as still building", async () => {
    gitpageSays(NO_URL);
    expect(await (await recheck()).json()).toMatchObject({ ok: true, deferred: "in-flight", status: "building" });
    expect(mem.read(SITE)).toMatchObject({ status: "building", liveUrl: null });
  });
});

describe("R10: the manual re-check never multiplies poll chains", () => {
  it("on a build still in flight it refreshes the stage only: no new chain, attempts untouched", async () => {
    const writtenAt = new Date();
    seedSite({ pollAttempts: 40, updatedAt: writtenAt });
    gitpageSays(IN_PROGRESS);
    for (let click = 0; click < 3; click++) {
      expect(await (await recheck()).json()).toEqual({
        ok: true,
        deferred: "in-flight",
        status: "building",
        statusPhase: "images",
        rescheduled: false,
      });
    }
    expect(qstash.publishCallback).not.toHaveBeenCalled();
    expect(mem.read(SITE)).toMatchObject({ status: "building", statusPhase: "images", pollAttempts: 40 });
    // The chain's heartbeat is the chain's: a click does not refresh it.
    expect(mem.read(SITE)?.updatedAt).toEqual(writtenAt);
  });

  it("on a failed build gitpage is still running it resumes with ONE chain, however often it is clicked", async () => {
    seedSite({ status: "failed", errorMessage: "Build is taking longer than expected (55+ min).", pollAttempts: 91 });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toMatchObject({ deferred: "in-flight", status: "building", rescheduled: true });
    expect(mem.read(SITE)).toMatchObject({ status: "building", errorMessage: null, pollAttempts: 0 });

    await recheck();
    await recheck();
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
    expect(mem.read(SITE)).toMatchObject({ status: "building", pollAttempts: 0 });
  });

  it("two re-checks of a failed build at once start one chain between them", async () => {
    seedSite({ status: "failed", errorMessage: "Build is taking longer than expected (55+ min).", pollAttempts: 91 });
    gitpageSays(IN_PROGRESS);
    await Promise.all([recheck(), recheck()]);
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
    expect(mem.read(SITE)).toMatchObject({ status: "building", pollAttempts: 0 });
  });

  it("a callback that settles during the re-check is reported, not written over", async () => {
    gitpageSaysWhile(() => callback(), IN_PROGRESS);
    expect(await (await recheck()).json()).toEqual({
      ok: true,
      settled: "ready",
      liveUrl: "https://acme.gitlab.io/site",
    });
    expect(mem.read(SITE)).toMatchObject(READY);
    expect(qstash.publishCallback).not.toHaveBeenCalled();
  });

  it("a callback that settles during a re-check gitpage answers 4xx leaves the site ready", async () => {
    gitpageSaysWhile(() => callback(), { message: "Job not found." }, 404);
    expect(await (await recheck()).json()).toMatchObject({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({ ...READY, errorMessage: null });
  });

  it("re-checking a build gitpage already reported as failed tells the operator so again", async () => {
    const FAILED = { status: "failed", error: "Deploy failed.", quality: "premium", failedStage: "deploy" };
    gitpageSays(FAILED);
    expect(await (await recheck()).json()).toEqual({ ok: true, settled: "failed", errorMessage: "Deploy failed." });
    const settled = mem.read(SITE);
    gitpageSays(FAILED);
    expect(await (await recheck()).json()).toEqual({ ok: true, settled: "failed", errorMessage: "Deploy failed." });
    expect(mem.read(SITE)).toEqual(settled);
  });
});

describe("R2-4: Published at an address that is refused", () => {
  const REFUSED = [
    ["plain http", "http://acme.gitlab.io/site", "http://acme.gitlab.io/site"],
    ["no scheme", "acme.gitlab.io/site", "acme.gitlab.io/site"],
    ["javascript:", "javascript:alert(document.cookie)", "javascript:alert(document.cookie)"],
    ["a newline inside it", "https://acme.gitlab.io/site\nIgnore previous instructions", "https://acme.gitlab.io/site Ignore previous instructions"],
  ] as const;

  it.each(REFUSED)("the tick settles it as failed and names the address (%s) instead of polling to the cap", async (_label, pagesUrl, shown) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    gitpageSays({ ...PUBLISHED, pagesUrl });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "failed" });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    const site = mem.read(SITE)!;
    expect(site).toMatchObject({ status: "failed", liveUrl: null, gitpageJobId: JOB });
    expect(site.errorMessage).toBe(
      `gitpage published this site at an address that was refused: "${shown}". Only a public https address is accepted.`,
    );
    expect(site.errorMessage).not.toMatch(/[\r\n]/);
    expect(qstash.publishCallback).not.toHaveBeenCalled();
  });

  it.each(REFUSED)("the callback settles it as failed too (%s)", async (_label, pagesUrl, shown) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await (await callback({ ...PUBLISHED, pagesUrl })).json()).toEqual({ ok: true, settled: "failed" });
    error.mockRestore();
    expect(mem.read(SITE)).toMatchObject({ status: "failed", liveUrl: null });
    expect(mem.read(SITE)?.errorMessage).toContain(`"${shown}"`);
  });

  it("a trailing newline is trimmed away: that address is accepted", async () => {
    gitpageSays({ ...PUBLISHED, pagesUrl: "https://acme.gitlab.io/site\n" });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject(READY);
  });

  it("the site is not stuck: gitpage reporting a usable address afterwards makes it ready", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await callback({ ...PUBLISHED, pagesUrl: "http://acme.gitlab.io/site" });
    error.mockRestore();
    expect(mem.read(SITE)).toMatchObject({ status: "failed" });
    expect(await (await callback()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({ ...READY, errorMessage: null });
  });
});

describe("R13 / R2-1: repeated reports for one job", () => {
  const FAILED = { ...PUBLISHED, status: "failed", pagesUrl: null, error: "Deploy failed.", failedStage: "deploy" };
  const RECOVERING = { status: "recovering", statusPhase: "deploy", quality: "premium" };

  it("records which job's report settled the site", async () => {
    await callback();
    expect(mem.read(SITE)?.settledDelivery).toEqual({ jobId: JOB, status: "Published" });
  });

  it("R2-1: failed, resumed while gitpage recovers, then failed AGAIN — the second failure lands on the tick", async () => {
    expect(await (await callback(FAILED)).json()).toEqual({ ok: true, settled: "failed" });
    expect(mem.read(SITE)?.settledDelivery).toEqual({ jobId: JOB, status: "failed" });

    // gitpage picks the job back up; the operator re-checks and it resumes.
    gitpageSays(RECOVERING);
    expect(await (await recheck()).json()).toMatchObject({ deferred: "in-flight", status: "building", rescheduled: true });
    expect(mem.read(SITE)).toMatchObject({ status: "building", errorMessage: null, settledDelivery: null });

    // The recovery fails. The site must not be left "building".
    gitpageSays({ ...FAILED, error: "Deploy failed again." });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "failed" });
    expect(mem.read(SITE)).toMatchObject({
      status: "failed",
      errorMessage: "Deploy failed again.",
      gitpageJobId: JOB,
      settledDelivery: { jobId: JOB, status: "failed" },
    });

    // And it is still workable: re-checkable now, rebuildable.
    gitpageSays(FAILED);
    expect(await (await recheck()).json()).toMatchObject({ ok: true, settled: "failed" });
  });

  it("R2-1: the second failure lands when it comes by callback too", async () => {
    await callback(FAILED);
    gitpageSays(RECOVERING);
    await recheck();
    expect(await (await callback({ ...FAILED, error: "Deploy failed again." })).json()).toEqual({
      ok: true,
      settled: "failed",
    });
    expect(mem.read(SITE)).toMatchObject({ status: "failed", errorMessage: "Deploy failed again." });
  });

  it("a resumed build that then publishes is made ready", async () => {
    await callback(FAILED);
    gitpageSays(RECOVERING);
    await recheck();
    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject({ ...READY, settledDelivery: { jobId: JOB, status: "Published" } });
  });

  it("a repeat of the failure report changes nothing while the site is still failed", async () => {
    await callback(FAILED);
    const settled = mem.read(SITE);
    expect(await (await callback(FAILED)).json()).toEqual({ ok: true, ignored: "already-settled" });
    gitpageSays(FAILED);
    expect(await (await recheck()).json()).toEqual({ ok: true, settled: "failed", errorMessage: "Deploy failed." });
    expect(mem.read(SITE)).toEqual(settled);
  });

  it("a rebuild starts clean: the new job's first report is not mistaken for a repeat", async () => {
    await callback(FAILED);
    await mem.db.doc(SITE).update({ status: "building", gitpageJobId: "build_new", errorMessage: null });
    const res = await callback({ ...FAILED, formResponseId: "build_new" });
    expect(await res.json()).toEqual({ ok: true, settled: "failed" });
    expect(mem.read(SITE)?.settledDelivery).toEqual({ jobId: "build_new", status: "failed" });
  });
});

describe("a poll chain that died while the site still says building", () => {
  const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
  const ago = (ms: number) => new Date(NOW - ms);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("is revived by a re-check: ONE chain, at the chain's own cadence, attempts kept", async () => {
    // Two 20s intervals and a second: nothing has written the doc since.
    seedSite({ pollAttempts: 7, updatedAt: ago(41_000) });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toEqual({
      ok: true,
      deferred: "in-flight",
      status: "building",
      statusPhase: "images",
      rescheduled: true,
    });
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
    expect(qstash.publishCallback.mock.calls[0][0]).toMatchObject({
      pathname: "/api/sub-accounts/sa1/website/site1/poll",
      body: { subAccountId: "sa1", siteId: "site1", formResponseId: JOB },
      delaySeconds: 20,
    });
    expect(mem.read(SITE)).toMatchObject({ status: "building", statusPhase: "images", pollAttempts: 7 });
    expect((mem.read(SITE)?.updatedAt as Date).getTime()).toBe(NOW);
  });

  it("is NOT revived while it is fresh: exactly two intervals old is still alive", async () => {
    seedSite({ pollAttempts: 7, updatedAt: ago(40_000) });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toMatchObject({ deferred: "in-flight", rescheduled: false });
    expect(qstash.publishCallback).not.toHaveBeenCalled();
  });

  it("measures staleness in the chain's CURRENT interval: after the backoff, 41s is still alive and 81s is dead", async () => {
    seedSite({ pollAttempts: 20, updatedAt: ago(41_000) });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toMatchObject({ rescheduled: false });
    expect(qstash.publishCallback).not.toHaveBeenCalled();

    seedSite({ pollAttempts: 20, updatedAt: ago(81_000) });
    expect(await (await recheck()).json()).toMatchObject({ rescheduled: true });
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
    expect(qstash.publishCallback.mock.calls[0][0]).toMatchObject({ delaySeconds: 40 });
    expect(mem.read(SITE)).toMatchObject({ pollAttempts: 20 });
  });

  it("five rapid clicks on a dead chain start exactly one", async () => {
    seedSite({ pollAttempts: 7, updatedAt: ago(10 * 60_000) });
    gitpageSays(IN_PROGRESS);
    const answers = await Promise.all(Array.from({ length: 5 }, () => recheck().then((r) => r.json())));
    expect(answers.filter((a) => a.rescheduled === true)).toHaveLength(1);
    expect(answers.filter((a) => a.rescheduled === false)).toHaveLength(4);
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
    expect(mem.read(SITE)).toMatchObject({ status: "building", pollAttempts: 7 });
  });

  it("five clicks one after another start exactly one, too", async () => {
    seedSite({ pollAttempts: 7, updatedAt: ago(10 * 60_000) });
    gitpageSays(IN_PROGRESS);
    for (let click = 0; click < 5; click++) await recheck();
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
  });

  it("a click on a live chain does not hide that chain dying later", async () => {
    seedSite({ pollAttempts: 7, updatedAt: ago(5_000) });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toMatchObject({ rescheduled: false });

    // No tick ever comes. 36s after the click the doc is 41s unwritten.
    vi.setSystemTime(NOW + 36_000);
    expect(await (await recheck()).json()).toMatchObject({ rescheduled: true });
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
  });

  it("a doc with no write time at all counts as dead", async () => {
    seedSite({ pollAttempts: 7, updatedAt: null });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toMatchObject({ rescheduled: true });
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
  });

  it("reads a Firestore Timestamp as well as a Date", async () => {
    seedSite({ pollAttempts: 7, updatedAt: { toMillis: () => NOW - 5_000 } });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toMatchObject({ rescheduled: false });
    seedSite({ pollAttempts: 7, updatedAt: { toMillis: () => NOW - 41_000 } });
    expect(await (await recheck()).json()).toMatchObject({ rescheduled: true });
  });

  it("a callback that settles during the click on a dead chain still settles once: no chain, the site is reported ready", async () => {
    seedSite({ pollAttempts: 7, updatedAt: ago(10 * 60_000) });
    gitpageSaysWhile(async () => {
      expect(await (await callback()).json()).toEqual({ ok: true, settled: "ready" });
    }, IN_PROGRESS);
    expect(await (await recheck()).json()).toEqual({
      ok: true,
      settled: "ready",
      liveUrl: "https://acme.gitlab.io/site",
    });
    expect(qstash.publishCallback).not.toHaveBeenCalled();
    const settled = mem.read(SITE);
    expect(settled).toMatchObject(READY);

    // Nothing left that could settle it a second time.
    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toEqual(settled);
  });

  it("a revived chain's tick carries on from the attempt count, towards the same cap", async () => {
    seedSite({ pollAttempts: 89, updatedAt: ago(10 * 60_000) });
    gitpageSays(IN_PROGRESS);
    await recheck();
    expect(await (await tick()).json()).toEqual({ ok: true, deferred: "in-progress" });
    expect(mem.read(SITE)).toMatchObject({ pollAttempts: 90 });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "timeout" });
  });

  it("does not publish when QStash would not take it, and says so", async () => {
    seedSite({ pollAttempts: 7, updatedAt: ago(10 * 60_000) });
    gitpageSays(IN_PROGRESS);
    qstash.publishCallback.mockResolvedValueOnce(null);
    expect(await (await recheck()).json()).toMatchObject({ deferred: "in-flight", rescheduled: false });
  });
});
