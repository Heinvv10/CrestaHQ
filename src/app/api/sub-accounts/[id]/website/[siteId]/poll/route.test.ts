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

const { POST: poll } = await import("./route");
const { POST: pollNow } = await import("../poll-now/route");
const { DELETE: removeOrReset } = await import("../route");
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

const reset = () =>
  removeOrReset(
    new Request("https://app.test/api/sub-accounts/sa1/website/site1?reset=1", {
      method: "DELETE",
      headers: { "x-user-uid": "u_owner" },
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
    expect(site.errorMessage).toContain("(30+ min)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the 45-tick cap for a job with no estimate on its doc", async () => {
    seedSite({ pollAttempts: 45, estimatedDurationSeconds: null });
    expect(await (await tick()).json()).toEqual({ ok: true, settled: "timeout" });
    expect(fetchMock).not.toHaveBeenCalled();
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
    seedSite({ status: "failed", errorMessage: "Build is taking longer than expected (30+ min).", pollAttempts: 91 });
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

  it("R6: a reset during a tick leaves a draft with no job, and the next tick is stale", async () => {
    gitpageSaysWhile(async () => {
      expect((await reset()).status).toBe(200);
    }, IN_PROGRESS);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toMatchObject({ status: "draft", gitpageJobId: null, liveUrl: null, pollAttempts: 0 });
    expect(qstash.publishCallback).not.toHaveBeenCalled();

    gitpageSays(PUBLISHED);
    expect(await (await tick()).json()).toEqual({ ok: true, ignored: "stale-tick" });
    expect(mem.read(SITE)).toMatchObject({ status: "draft", gitpageJobId: null, liveUrl: null });
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
  const timedOut = { status: "failed", errorMessage: "Build is taking longer than expected (30+ min).", pollAttempts: 91 };

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
    ["a javascript: URL", "javascript:alert(document.cookie)"],
    ["a plain-http URL", "http://acme.gitlab.io/site"],
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
    seedSite({ pollAttempts: 40 });
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
  });

  it("on a failed build gitpage is still running it resumes with ONE chain, however often it is clicked", async () => {
    seedSite({ status: "failed", errorMessage: "Build is taking longer than expected (30+ min).", pollAttempts: 91 });
    gitpageSays(IN_PROGRESS);
    expect(await (await recheck()).json()).toMatchObject({ deferred: "in-flight", status: "building", rescheduled: true });
    expect(mem.read(SITE)).toMatchObject({ status: "building", errorMessage: null, pollAttempts: 0 });

    await recheck();
    await recheck();
    expect(qstash.publishCallback).toHaveBeenCalledTimes(1);
    expect(mem.read(SITE)).toMatchObject({ status: "building", pollAttempts: 0 });
  });

  it("two re-checks of a failed build at once start one chain between them", async () => {
    seedSite({ status: "failed", errorMessage: "Build is taking longer than expected (30+ min).", pollAttempts: 91 });
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

describe("R13: a replayed callback", () => {
  const FAILED = { ...PUBLISHED, status: "failed", pagesUrl: null, error: "Deploy failed.", failedStage: "deploy" };

  it("records which job's report settled the site", async () => {
    await callback();
    expect(mem.read(SITE)?.settledDelivery).toEqual({ jobId: JOB, status: "Published" });
  });

  it("cannot re-fail a build the operator resumed after the same failure report", async () => {
    expect(await (await callback(FAILED)).json()).toEqual({ ok: true, settled: "failed" });
    // gitpage picks the job back up; the operator re-checks and it resumes.
    gitpageSays(IN_PROGRESS);
    await recheck();
    expect(mem.read(SITE)).toMatchObject({ status: "building", errorMessage: null });

    expect(await (await callback(FAILED)).json()).toEqual({ ok: true, settled: "noop" });
    expect(mem.read(SITE)).toMatchObject({ status: "building", errorMessage: null });

    // A DIFFERENT report for the same job still lands.
    expect(await (await callback()).json()).toEqual({ ok: true, settled: "ready" });
    expect(mem.read(SITE)).toMatchObject(READY);
  });

  it("a rebuild starts clean: the new job's first report is not mistaken for a repeat", async () => {
    await callback(FAILED);
    await mem.db.doc(SITE).update({ status: "building", gitpageJobId: "build_new", errorMessage: null });
    const res = await callback({ ...FAILED, formResponseId: "build_new" });
    expect(await res.json()).toEqual({ ok: true, settled: "failed" });
    expect(mem.read(SITE)?.settledDelivery).toEqual({ jobId: "build_new", status: "failed" });
  });
});
