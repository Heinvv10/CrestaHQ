import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { NICHE_KEYS } from "@/lib/website/niches";
import { sampleWebsiteConfig, type WebsiteConfig } from "@/types/website";

/**
 * Website Build v2 on the submit side: every build is premium, the poll cap
 * and cadence derive from gitpage's duration estimate, and the request tells
 * gitpage where to call back and who may edit the site. Real service + real
 * gitpage client over the in-memory Firestore; only the outbound fetch, the
 * QStash publish and the Auth lookup are stubbed.
 */

const mem = createMemoryFirestore();
const users: Record<string, { email?: string }> = { u1: { email: "  Owner@Acme.TEST " } };
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => {
      if (!users[uid]) throw new Error("auth/user-not-found");
      return users[uid];
    },
  }),
}));
const publishCallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, publishCallback }));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const {
  createWebsiteForSubAccount,
  normalizeWebsiteConfig,
  pollAttemptCapFor,
  pollDelayFor,
  submitWebsiteBuildForSubAccount,
  websiteLimitsPath,
  WebsiteServiceError,
} = await import("./websites-service");

describe("pollAttemptCapFor", () => {
  it("keeps the historical 45 ticks for a standard build and when gitpage sent no estimate", () => {
    expect(pollAttemptCapFor(300)).toBe(45);
    expect(pollAttemptCapFor(null)).toBe(45);
    expect(pollAttemptCapFor(undefined)).toBe(45);
    expect(pollAttemptCapFor(0)).toBe(45);
    expect(pollAttemptCapFor(-5)).toBe(45);
  });

  it("gives a premium build 1.5× its estimate at the base cadence", () => {
    expect(pollAttemptCapFor(1200)).toBe(90);
    expect(pollAttemptCapFor(800)).toBe(60);
    // Rounds a part tick up.
    expect(pollAttemptCapFor(610)).toBe(46);
  });

  it("never drops below 45 ticks nor exceeds 120", () => {
    expect(pollAttemptCapFor(60)).toBe(45);
    expect(pollAttemptCapFor(1600)).toBe(120);
    expect(pollAttemptCapFor(1601)).toBe(120);
    expect(pollAttemptCapFor(86_400)).toBe(120);
  });
});

describe("pollDelayFor", () => {
  it("polls every 20s for the first five minutes, then every 40s", () => {
    expect(pollDelayFor(0)).toBe(20);
    expect(pollDelayFor(14)).toBe(20);
    expect(pollDelayFor(15)).toBe(40);
    expect(pollDelayFor(119)).toBe(40);
  });
});

describe("normalizeWebsiteConfig — Build v2", () => {
  const normalized = (patch: Partial<WebsiteConfig>) => {
    const config = { ...sampleWebsiteConfig(), ...patch };
    normalizeWebsiteConfig(config);
    return config;
  };

  it("forces premium whatever the draft says", () => {
    expect(normalized({ quality: "standard" }).quality).toBe("premium");
    expect(normalized({ quality: undefined }).quality).toBe("premium");
    expect(normalized({ quality: "premium" }).quality).toBe("premium");
  });

  it("an old standard draft builds as premium with the form and chat on", () => {
    const legacy = normalized({
      quality: "standard",
      include_form: undefined,
      include_chat: undefined,
      concept: undefined,
      hero_motion: undefined,
      premium_details: undefined,
    });
    expect(legacy).toMatchObject({
      quality: "premium",
      include_form: true,
      include_chat: true,
      concept: null,
      hero_motion: null,
      premium_details: null,
    });
  });

  it("keeps an explicit opt-out of the form or the chat widget", () => {
    expect(normalized({ include_form: false, include_chat: false })).toMatchObject({
      include_form: false,
      include_chat: false,
    });
  });

  it("trims the concept id and stores a blank one as null", () => {
    expect(normalized({ concept: "  atelier " }).concept).toBe("atelier");
    expect(normalized({ concept: "   " }).concept).toBeNull();
  });

  it("names every niche in the error for an unknown one", () => {
    let error: unknown;
    try {
      normalized({ niche: "dentist" as WebsiteConfig["niche"] });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(WebsiteServiceError);
    expect((error as InstanceType<typeof WebsiteServiceError>).status).toBe(400);
    for (const niche of NICHE_KEYS) expect((error as Error).message).toContain(niche);
  });
});

describe("submitWebsiteBuildForSubAccount — Build v2 request", () => {
  const SITE = "subAccounts/sa1/website/site1";
  const fetchMock = vi.fn();
  const ORIGINAL = {
    key: process.env.GITPAGE_API_KEY,
    url: process.env.GITPAGE_API_URL,
    app: process.env.NEXT_PUBLIC_APP_URL,
  };

  /** The JSON body of the one request the build sent to gitpage. */
  const sent = () => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://gitpage.test/api/v1/generate-site");
    return JSON.parse(init.body) as Record<string, unknown>;
  };

  const build = (opts: { uid?: string; config?: WebsiteConfig; siteId?: string; subAccountId?: string } = {}) =>
    submitWebsiteBuildForSubAccount({
      subAccountId: opts.subAccountId ?? "sa1",
      siteId: opts.siteId ?? "site1",
      config: opts.config ?? { ...sampleWebsiteConfig(), quality: "standard" },
      buildByUid: opts.uid ?? "u1",
    });

  beforeEach(() => {
    process.env.GITPAGE_API_KEY = "gp_test_key";
    process.env.GITPAGE_API_URL = "https://gitpage.test";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test/";
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Acme" });
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "draft", provisioning: { errors: ["old"] } });
    publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
    // Each accepted submit gets its own job id, as gitpage issues them.
    let jobs = 0;
    fetchMock.mockReset().mockImplementation(async () => {
      jobs += 1;
      const id = jobs === 1 ? "build_abc" : `build_abc_${jobs}`;
      return Response.json(
        { formResponseId: id, pollUrl: `https://gitpage.test/s/${id}`, estimatedDurationSeconds: 1200 },
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const [name, value] of [
      ["GITPAGE_API_KEY", ORIGINAL.key],
      ["GITPAGE_API_URL", ORIGINAL.url],
      ["NEXT_PUBLIC_APP_URL", ORIGINAL.app],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("asks gitpage for a premium build on the forced model tier, even from a standard draft", async () => {
    await build();
    expect(sent()).toMatchObject({ quality: "premium", claudeModel: "opus-5.5", subAccountId: "sa1" });
    expect(sent().premium).toMatchObject({ mode: "light" });
  });

  it("tells gitpage where to call back and whom to invite as editor", async () => {
    await build();
    expect(sent()).toMatchObject({
      callbackUrl: "https://crm.example.test/api/webhooks/gitpage/build-settled",
      editorEmail: "owner@acme.test",
    });
  });

  it.each([
    ["a loopback app URL", "http://127.0.0.1:3100"],
    ["a plain-http app URL", "http://crm.example.test"],
    ["an app URL with a path", "https://example.test/crm"],
    ["no app URL", ""],
  ])("sends no callback URL with %s — gitpage could not reach it", async (_label, appUrl) => {
    process.env.NEXT_PUBLIC_APP_URL = appUrl;
    await build();
    expect(sent()).not.toHaveProperty("callbackUrl");
  });

  it("still builds, without an editor invite, when the builder has no Auth record or email", async () => {
    await build({ uid: "u_gone" });
    expect(sent()).not.toHaveProperty("editorEmail");
    expect(mem.read(SITE)).toMatchObject({ status: "queued", editorEmail: null });
  });

  it("sends no LeadStack form or widget wiring yet (the WS-3 hand-off is not ported)", async () => {
    await build();
    expect(sent()).not.toHaveProperty("leadstack");
    expect(mem.read(SITE)?.formId).toBeNull();
    expect(mem.list("forms")).toEqual([]);
  });

  it("records the job's v2 bookkeeping and clears the previous build's", async () => {
    await build();
    expect(mem.read(SITE)).toMatchObject({
      status: "queued",
      gitpageJobId: "build_abc",
      quality: "premium",
      estimatedDurationSeconds: 1200,
      statusPhase: null,
      conceptName: null,
      provisioning: null,
      gitpagePageId: null,
      editorEmail: "owner@acme.test",
      config: { quality: "premium", include_form: true, include_chat: true },
    });
  });

  it.each(["queued", "building"])("R10: refuses with 409 while the site is %s, without calling gitpage or touching the job", async (status) => {
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status, gitpageJobId: "build_running" });
    const before = mem.read(SITE);
    await expect(build()).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishCallback).not.toHaveBeenCalled();
    expect(mem.read(SITE)).toEqual(before);
  });

  it("R10: of two submits for one site at once, one takes it and the other gets 409 — the site holds exactly one job", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await Promise.allSettled([build(), build()]);
    error.mockRestore();
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
    const won = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ formResponseId: string }>;
    expect(mem.read(SITE)).toMatchObject({ status: "queued", gitpageJobId: won.value.formResponseId });
    // One poll chain, for the job the site actually holds.
    expect(publishCallback).toHaveBeenCalledTimes(1);
    expect(publishCallback.mock.calls[0][0].body.formResponseId).toBe(won.value.formResponseId);
  });

  it("R10: a build on an id with no doc is refused at the site cap, before gitpage is called", async () => {
    await mem.db.doc(SITE).delete();
    for (let i = 1; i <= 5; i++) {
      mem.seed(`subAccounts/sa1/website/s${i}`, { id: `s${i}`, subAccountId: "sa1", status: "draft" });
    }
    await expect(build()).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SITE)).toBeUndefined();
    expect(mem.list("subAccounts/sa1/website")).toHaveLength(5);
  });

  it("a build on an id with no doc still creates it, stamped with its tenancy, while under the cap", async () => {
    await mem.db.doc(SITE).delete();
    await build();
    expect(mem.read(SITE)).toMatchObject({
      id: "site1",
      agencyId: "ag1",
      subAccountId: "sa1",
      status: "queued",
      gitpageJobId: "build_abc",
    });
  });

  describe("the hourly build counter", () => {
    const HOUR = 60 * 60 * 1000;
    const T0 = Date.UTC(2026, 9, 10, 8, 0, 0);
    const rebuild = async () => {
      await mem.db.doc(SITE).update({ status: "ready" });
      return build();
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
    });

    it("R10: a sub-account gets 10 build submits an hour; the 11th is 429 with a retry time and never reaches gitpage", async () => {
      for (let i = 0; i < 10; i++) await rebuild();
      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0, count: 10 });

      vi.setSystemTime(T0 + 20 * 60 * 1000);
      const before = mem.read(SITE);
      await mem.db.doc(SITE).update({ status: "ready" });
      await expect(build()).rejects.toMatchObject({ status: 429, retryAfterSec: 40 * 60 });
      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect(mem.read(SITE)).toMatchObject({ gitpageJobId: before?.gitpageJobId, status: "ready" });
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0, count: 10 });

      // Another workspace is not held back by this one...
      mem.seed("subAccounts/sa2", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Other" });
      await build({ subAccountId: "sa2", siteId: "siteB" });
      expect(fetchMock).toHaveBeenCalledTimes(11);

      // ...and this one is let through again once the hour has passed.
      vi.setSystemTime(T0 + HOUR);
      await build();
      expect(fetchMock).toHaveBeenCalledTimes(12);
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0 + HOUR, count: 1 });
    });

    it("R2-5: 25 submits at once, each for its own site, never reach gitpage more than 10 times — and every one that does was counted", async () => {
      for (let i = 0; i < 25; i++) {
        mem.seed(`subAccounts/sa1/website/c${i}`, { id: `c${i}`, agencyId: "ag1", subAccountId: "sa1", status: "ready" });
      }
      const results = await Promise.allSettled(
        Array.from({ length: 25 }, (_, i) => build({ siteId: `c${i}` })),
      );
      const through = results.filter((r) => r.status === "fulfilled").length;
      // A reservation that loses to contention is refused (fails closed), so
      // fewer than ten may get through in one burst — never more.
      expect(through).toBeGreaterThan(0);
      expect(through).toBeLessThanOrEqual(10);
      expect(fetchMock).toHaveBeenCalledTimes(through);
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ count: through });
      for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
        expect(r.reason).toBeInstanceOf(WebsiteServiceError);
        expect(r.reason).toMatchObject({ status: 429, retryAfterSec: expect.any(Number) });
      }

      // The rest of the hour's allowance is still there, and it ends at ten.
      for (let i = through; i < 10; i++) await rebuild();
      await mem.db.doc(SITE).update({ status: "ready" });
      await expect(build()).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it("the reset route is no way round it: reset-and-rebuild is still 10 an hour", async () => {
      // A reset clears the in-flight state, so the 409 does not apply — only the counter does.
      const resetAndBuild = async () => {
        await mem.db.doc(SITE).update({ status: "draft", gitpageJobId: null });
        return build();
      };
      for (let i = 0; i < 10; i++) await resetAndBuild();
      await expect(resetAndBuild()).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it("counts across instances: a second copy of the service sees the first one's submits", async () => {
      for (let i = 0; i < 10; i++) await rebuild();
      vi.resetModules();
      const other = await import("./websites-service");
      expect(other.submitWebsiteBuildForSubAccount).not.toBe(submitWebsiteBuildForSubAccount);
      await mem.db.doc(SITE).update({ status: "ready" });
      await expect(
        other.submitWebsiteBuildForSubAccount({
          subAccountId: "sa1",
          siteId: "site1",
          config: sampleWebsiteConfig(),
          buildByUid: "u1",
        }),
      ).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it("a submit gitpage rejects still uses up one of the ten", async () => {
      fetchMock.mockImplementation(async () => Response.json({ message: "Invalid palette." }, { status: 422 }));
      for (let i = 0; i < 10; i++) await expect(build()).rejects.toMatchObject({ status: 422 });
      await expect(build()).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });
  });

  describe("R2-3: the site is removed while the submit is waiting on gitpage", () => {
    const acceptedAfter = (during: () => Promise<unknown>) =>
      fetchMock.mockImplementationOnce(async () => {
        await during();
        return Response.json(
          { formResponseId: "build_orphan", pollUrl: "https://gitpage.test/s/build_orphan", estimatedDurationSeconds: 1200 },
          { status: 202 },
        );
      });

    it("stays removed: the build is refused with 409, the orphaned job is logged, no poll is scheduled", async () => {
      acceptedAfter(() => mem.db.doc(SITE).delete());
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(build()).rejects.toMatchObject({ status: 409 });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toContain("orphanedJob=build_orphan");
      expect(error.mock.calls[0][0]).toContain("(missing)");
      error.mockRestore();
      expect(mem.read(SITE)).toBeUndefined();
      expect(mem.list("subAccounts/sa1/website")).toEqual([]);
      expect(publishCallback).not.toHaveBeenCalled();
    });

    it("a doc the submit does create always carries its tenancy keys", async () => {
      await mem.db.doc(SITE).delete();
      await build();
      expect(mem.read(SITE)).toMatchObject({ id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "queued" });
      for (const site of mem.list("subAccounts/sa1/website")) {
        expect(site.agencyId).toBe("ag1");
        expect(site.subAccountId).toBe("sa1");
      }
    });
  });

  describe("R2-6: the site cap under concurrency", () => {
    it("8 builds at once on never-created ids leave exactly 5 sites, each with its tenancy keys", async () => {
      await mem.db.doc(SITE).delete();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => build({ siteId: `n${i}` })),
      );
      error.mockRestore();
      const sites = mem.list("subAccounts/sa1/website");
      const through = results.filter((r) => r.status === "fulfilled").length;
      expect(sites.length).toBeLessThanOrEqual(5);
      expect(sites).toHaveLength(through);
      for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
        expect(r.reason).toBeInstanceOf(WebsiteServiceError);
        expect([409, 429]).toContain(r.reason.status);
      }
      for (const site of sites) {
        expect(site).toMatchObject({ agencyId: "ag1", subAccountId: "sa1", status: "queued" });
      }
      // Only the builds that took a slot are polled.
      expect(publishCallback).toHaveBeenCalledTimes(through);

      // Fill what is left one at a time: the sixth site is refused at the cap.
      for (let i = sites.length; i < 5; i++) await build({ siteId: `late${i}` });
      await expect(build({ siteId: "sixth" })).rejects.toMatchObject({ status: 409 });
      expect(mem.list("subAccounts/sa1/website")).toHaveLength(5);
    });

    it("3 sites exist: 8 builds at once on new ids add exactly 2", async () => {
      for (let i = 0; i < 2; i++) {
        mem.seed(`subAccounts/sa1/website/old${i}`, { id: `old${i}`, agencyId: "ag1", subAccountId: "sa1", status: "ready" });
      }
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await Promise.allSettled(Array.from({ length: 8 }, (_, i) => build({ siteId: `n${i}` })));
      error.mockRestore();
      // site1 + old0 + old1 were there; two slots were free.
      expect(mem.list("subAccounts/sa1/website")).toHaveLength(5);
    });

    it("8 creates at once (the Add website route) leave exactly 5 sites", async () => {
      await mem.db.doc(SITE).delete();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => createWebsiteForSubAccount({ subAccountId: "sa1" })),
      );
      const through = results.filter((r) => r.status === "fulfilled").length;
      let sites = mem.list("subAccounts/sa1/website");
      expect(sites.length).toBeLessThanOrEqual(5);
      expect(sites).toHaveLength(through);
      for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
        expect(r.reason).toBeInstanceOf(WebsiteServiceError);
        expect([409, 429]).toContain(r.reason.status);
      }
      for (let i = sites.length; i < 5; i++) await createWebsiteForSubAccount({ subAccountId: "sa1" });
      await expect(createWebsiteForSubAccount({ subAccountId: "sa1" })).rejects.toMatchObject({ status: 409 });
      sites = mem.list("subAccounts/sa1/website");
      expect(sites).toHaveLength(5);
      // Numbered from the count each create saw inside its transaction: no two alike.
      expect(sites.map((s) => s.name).sort()).toEqual(["Website 1", "Website 2", "Website 3", "Website 4", "Website 5"]);
    });

    it("creates and new-id builds at once share the one cap", async () => {
      await mem.db.doc(SITE).delete();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await Promise.allSettled([
        ...Array.from({ length: 4 }, () => createWebsiteForSubAccount({ subAccountId: "sa1" })),
        ...Array.from({ length: 4 }, (_, i) => build({ siteId: `n${i}` })),
      ]);
      error.mockRestore();
      expect(mem.list("subAccounts/sa1/website").length).toBeLessThanOrEqual(5);
      for (let i = mem.list("subAccounts/sa1/website").length; i < 5; i++) {
        await createWebsiteForSubAccount({ subAccountId: "sa1" });
      }
      await expect(build({ siteId: "sixth" })).rejects.toMatchObject({ status: 409 });
      await expect(createWebsiteForSubAccount({ subAccountId: "sa1" })).rejects.toMatchObject({ status: 409 });
      expect(mem.list("subAccounts/sa1/website")).toHaveLength(5);
    });
  });

  it("a submit refused before gitpage is called does not use up the hourly allowance", async () => {
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "building", gitpageJobId: "build_running" });
    for (let i = 0; i < 25; i++) await expect(build()).rejects.toMatchObject({ status: 409 });
    await mem.db.doc(SITE).update({ status: "failed" });
    await build();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("schedules the first poll 20 seconds out", async () => {
    await build();
    expect(publishCallback).toHaveBeenCalledTimes(1);
    expect(publishCallback.mock.calls[0][0]).toMatchObject({
      pathname: "/api/sub-accounts/sa1/website/site1/poll",
      delaySeconds: 20,
      body: { subAccountId: "sa1", siteId: "site1", formResponseId: "build_abc" },
    });
  });
});
