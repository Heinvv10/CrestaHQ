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
// The apex → www probe has its own tests (app-url.test.ts). Here it answers
// what the test sets: null means "nothing resolved", and the callers fall
// back to NEXT_PUBLIC_APP_URL, which they validate themselves.
const appUrl = vi.hoisted(() => ({ resolved: null as string | null }));
vi.mock("@/lib/server/app-url", () => ({ resolvedAppUrl: async () => appUrl.resolved }));

const {
  createWebsiteForSubAccount,
  normalizeWebsiteConfig,
  pollAttemptCapFor,
  pollChainStaleAfterMs,
  pollDelayFor,
  pollWindowSecondsFor,
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

describe("pollWindowSecondsFor", () => {
  it("is the wall clock the cap really spans, backoff included", () => {
    // 90 ticks: 20s to the first, 20s after ticks 1–14, 40s after ticks 15–90.
    expect(pollWindowSecondsFor(1200)).toBe(20 + 14 * 20 + 76 * 40);
    expect(Math.floor(pollWindowSecondsFor(1200) / 60)).toBe(55);
    // The 45-tick floor.
    expect(pollWindowSecondsFor(null)).toBe(20 + 14 * 20 + 31 * 40);
    expect(Math.floor(pollWindowSecondsFor(300) / 60)).toBe(25);
    // The 120-tick ceiling.
    expect(pollWindowSecondsFor(86_400)).toBe(20 + 14 * 20 + 106 * 40);
  });

  it("is built from pollDelayFor, tick by tick", () => {
    for (const estimate of [null, 300, 800, 1200, 1600]) {
      const cap = pollAttemptCapFor(estimate);
      let seconds = pollDelayFor(0);
      for (let attempts = 1; attempts <= cap; attempts++) seconds += pollDelayFor(attempts);
      expect(pollWindowSecondsFor(estimate)).toBe(seconds);
    }
  });
});

describe("pollChainStaleAfterMs", () => {
  it("is two of the chain's current intervals", () => {
    expect(pollChainStaleAfterMs(0)).toBe(2 * pollDelayFor(0) * 1000);
    expect(pollChainStaleAfterMs(14)).toBe(40_000);
    expect(pollChainStaleAfterMs(15)).toBe(80_000);
    expect(pollChainStaleAfterMs(90)).toBe(2 * pollDelayFor(90) * 1000);
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
    appUrl.resolved = null;
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

  it("a 2xx from gitpage without a job is a fixed-text 502: the site stays put and the hour's build is spent", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementationOnce(async () => Response.json({ ok: true, note: "<b>not a build</b>" }, { status: 202 }));
    let error: unknown;
    await build().catch((err: unknown) => (error = err));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("gitpage answered 202 without a build"));
    logged.mockRestore();
    expect(error).toBeInstanceOf(WebsiteServiceError);
    expect(error).toMatchObject({
      status: 502,
      message: "The website builder did not start the build. Nothing was built — try again in a few minutes.",
      gitpageStatus: undefined,
      gitpageBody: undefined,
      submissionOutcome: "unknown",
    });
    expect(mem.read(SITE)).toMatchObject({ status: "draft" });
    expect(mem.read(SITE)?.gitpageJobId).toBeUndefined();
    expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ count: 1 });
    expect(publishCallback).not.toHaveBeenCalled();
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

  it("still builds, without an editor invite, when the builder has no Auth record — and says why in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await build({ uid: "u_gone" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("[website/build] could not read the builder's email");
    expect(warn.mock.calls[0][0]).toContain("uid=u_gone");
    warn.mockRestore();
    expect(sent()).not.toHaveProperty("editorEmail");
    expect(mem.read(SITE)).toMatchObject({ status: "queued", editorEmail: null });
  });

  it("a builder with an Auth record but no email is not an error: no invite, no warning", async () => {
    users.u_noemail = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await build({ uid: "u_noemail" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(sent()).not.toHaveProperty("editorEmail");
  });

  it("creates the Website contact form before the request and bakes its submit URL and the widget into the site", async () => {
    await build();
    const forms = mem.list("forms");
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ name: "Website contact", subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1" });
    const formId = forms[0].id;
    expect(sent().leadstack).toEqual({
      appUrl: "https://crm.example.test",
      subAccountId: "sa1",
      formId,
      formSubmitUrl: `https://crm.example.test/api/forms/${formId}/submit`,
      widgetScriptUrl: "https://crm.example.test/widget.js",
    });
    expect(mem.read(SITE)?.formId).toBe(formId);
  });

  it("bakes the redirect-resolved app origin (apex → www) into the wiring and the callback URL", async () => {
    appUrl.resolved = "https://www.crm.example.test";
    await build();
    expect(sent()).toMatchObject({
      callbackUrl: "https://www.crm.example.test/api/webhooks/gitpage/build-settled",
      leadstack: { appUrl: "https://www.crm.example.test", widgetScriptUrl: "https://www.crm.example.test/widget.js" },
    });
  });

  it("reuses the one form on a rebuild and for a second site in the workspace", async () => {
    await build();
    const formId = mem.list("forms")[0].id;
    await mem.db.doc(SITE).update({ status: "ready" });
    await build();
    mem.seed("subAccounts/sa1/website/site2", { id: "site2", agencyId: "ag1", subAccountId: "sa1", status: "draft" });
    await build({ siteId: "site2" });
    expect(mem.list("forms")).toHaveLength(1);
    expect(mem.read("subAccounts/sa1/website/site2")?.formId).toBe(formId);
  });

  it("two sites submitted at the same moment end up sharing ONE form", async () => {
    mem.seed("subAccounts/sa1/website/site2", { id: "site2", agencyId: "ag1", subAccountId: "sa1", status: "draft" });
    await Promise.all([build(), build({ siteId: "site2" })]);
    const forms = mem.list("forms");
    expect(forms).toHaveLength(1);
    expect(mem.read(SITE)?.formId).toBe(forms[0].id);
    expect(mem.read("subAccounts/sa1/website/site2")?.formId).toBe(forms[0].id);
  });

  it("a build without the lead form creates none and sends only the widget", async () => {
    await build({ config: { ...sampleWebsiteConfig(), include_form: false } });
    expect(mem.list("forms")).toEqual([]);
    expect(sent().leadstack).toEqual({
      appUrl: "https://crm.example.test",
      subAccountId: "sa1",
      widgetScriptUrl: "https://crm.example.test/widget.js",
    });
    expect(mem.read(SITE)?.formId).toBeNull();
  });

  it("sends no wiring at all when the app URL is not public https — and says so in the log", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await build();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no LeadStack form/widget wiring"))).toBe(true);
    warn.mockRestore();
    expect(sent()).not.toHaveProperty("leadstack");
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

    it("clearing the in-flight state is no way round it: back-to-draft-and-build is still 10 an hour", async () => {
      // A site with no job in flight is not refused with 409 — only the counter applies.
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

    it.each([
      ["422", 422, { message: "Invalid palette." }],
      ["429", 429, { message: "Hourly cap reached." }],
      ["408", 408, { message: "Request timed out." }],
      ["425", 425, { message: "Too early." }],
      ["500", 500, { error: "Internal error." }],
      ["502", 502, { error: "Bad gateway." }],
      ["503 with no JSON body", 503, null],
    ])("an HTTP %s from gitpage uses up one of the ten", async (_label, status, body) => {
      fetchMock.mockImplementation(async () =>
        body === null ? new Response("<html>down</html>", { status }) : Response.json(body, { status }),
      );
      for (let i = 0; i < 10; i++) {
        await expect(build()).rejects.toMatchObject({
          gitpageStatus: status,
          submissionOutcome:
            status < 500 && status !== 408 && status !== 425
              ? "not-accepted"
              : "unknown",
        });
      }
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0, count: 10 });
      await expect(build()).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it.each([
      ["a network error", () => new TypeError("fetch failed")],
      ["a timeout", () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
      ["a connection reset after the request was sent", () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ])("a request that throws (%s) ALSO uses up one of the ten — a throw does not prove gitpage was not reached", async (_label, failure) => {
      fetchMock.mockImplementation(async () => {
        throw failure();
      });
      for (let i = 0; i < 10; i++) {
        await expect(build()).rejects.toMatchObject({
          status: 502,
          submissionOutcome: "unknown",
        });
        expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0, count: i + 1 });
      }
      // The eleventh attempt is refused without a call, outage or not...
      await expect(build()).rejects.toMatchObject({ status: 429, retryAfterSec: 60 * 60 });
      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0, count: 10 });

      // ...and nothing but the window rolling opens it again.
      vi.setSystemTime(T0 + HOUR - 1);
      await expect(build()).rejects.toMatchObject({ status: 429 });
      vi.setSystemTime(T0 + HOUR);
      fetchMock.mockImplementation(async () =>
        Response.json({ formResponseId: "build_back", pollUrl: "https://gitpage.test/s/build_back" }, { status: 202 }),
      );
      await build();
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0 + HOUR, count: 1 });
    });

    it("a mix of accepted, rejected and thrown submits all count, in whatever order", async () => {
      const answers: Array<() => Promise<Response>> = [
        async () => Response.json({ formResponseId: "b1", pollUrl: "https://gitpage.test/s/b1" }, { status: 202 }),
        async () => { throw new TypeError("fetch failed"); },
        async () => Response.json({ error: "Bad gateway." }, { status: 502 }),
        async () => { throw new TypeError("fetch failed"); },
        async () => Response.json({ message: "Invalid palette." }, { status: 422 }),
      ];
      for (const answer of answers) {
        await mem.db.doc(SITE).update({ status: "ready" });
        fetchMock.mockImplementationOnce(answer);
        await build().catch(() => undefined);
      }
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0, count: 5 });
    });

    it.each([
      ["NaN", Number.NaN],
      ["a string", "3"],
      ["negative", -4],
      ["a fraction", 2.5],
      ["missing", undefined],
    ])("fails closed on a count that is %s inside an open window", async (_label, count) => {
      mem.seed(websiteLimitsPath("sa1"), { windowStart: T0, ...(count === undefined ? {} : { count }) });
      await expect(build()).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a window start a few seconds ahead (another instance's clock) is still this window", async () => {
      mem.seed(websiteLimitsPath("sa1"), { windowStart: T0 + 5_000, count: 10 });
      await expect(build()).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a window start more than an hour away is not a window: a new one opens", async () => {
      mem.seed(websiteLimitsPath("sa1"), { windowStart: T0 + 3 * HOUR, count: 10 });
      await build();
      expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ windowStart: T0, count: 1 });
    });
  });

  describe("the site cap counts where the doc is written", () => {
    it.each([
      ["a nested path", "x/y/z"],
      ["a path into another collection", "site1/private/doc"],
      ["a parent reference", ".."],
      ["empty", ""],
      ["a reserved id", "__site__"],
    ])("refuses a site id that is %s with 404, before gitpage is called, creating nothing", async (_label, siteId) => {
      const before = mem.all();
      await expect(build({ siteId })).rejects.toMatchObject({ status: 404 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mem.all()).toEqual(before);
    });

    it("a path-shaped site id cannot get a sixth site past the cap", async () => {
      for (let i = 2; i <= 5; i++) {
        mem.seed(`subAccounts/sa1/website/s${i}`, { id: `s${i}`, agencyId: "ag1", subAccountId: "sa1", status: "ready" });
      }
      expect(mem.list("subAccounts/sa1/website")).toHaveLength(5);
      for (const siteId of ["s2/more/sixth", "sixth/a/b", "site1/x/y"]) {
        await expect(build({ siteId })).rejects.toMatchObject({ status: 404 });
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mem.all().filter((d) => d.path.startsWith("subAccounts/sa1/website/"))).toHaveLength(5);
    });

    it.each([
      ["a site doc's path", "sa1/website/site1"],
      ["a nested path", "sa1/x/y"],
      ["a two-segment path", "sa1/website"],
      ["a parent reference", ".."],
      ["empty", ""],
    ])("Add website refuses a sub-account id that is %s with 404, before anything touches Firestore", async (_label, subAccountId) => {
      // A doc at that path that would pass the gate read, were it reached.
      mem.seed("subAccounts/sa1/website/site1", { agencyId: "ag1", subAccountId: "sa1", websiteEnabledByAgency: true });
      mem.seed("subAccounts/sa1/x/y", { agencyId: "ag1", websiteEnabledByAgency: true });
      const before = mem.all();
      const doc = vi.spyOn(mem.db, "doc");
      const collection = vi.spyOn(mem.db, "collection");
      const runTransaction = vi.spyOn(mem.db, "runTransaction");
      await expect(createWebsiteForSubAccount({ subAccountId })).rejects.toMatchObject({ status: 404 });
      expect(doc).not.toHaveBeenCalled();
      expect(collection).not.toHaveBeenCalled();
      expect(runTransaction).not.toHaveBeenCalled();
      doc.mockRestore();
      collection.mockRestore();
      runTransaction.mockRestore();
      expect(mem.all()).toEqual(before);
    });

    it("Add website on a path-shaped sub-account id that passes the gate read would otherwise create a nested site: it does not", async () => {
      mem.seed("subAccounts/sa1/x/y", { agencyId: "ag1", websiteEnabledByAgency: true });
      await expect(createWebsiteForSubAccount({ subAccountId: "sa1/x/y" })).rejects.toMatchObject({ status: 404 });
      expect(mem.all().filter((d) => d.path.startsWith("subAccounts/sa1/x/y/"))).toEqual([]);
    });

    it("refuses a sub-account id that is a path", async () => {
      await expect(build({ subAccountId: "sa1/website/site1" })).rejects.toMatchObject({ status: 404 });
      expect(fetchMock).not.toHaveBeenCalled();
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
      await expect(build()).rejects.toMatchObject({
        status: 409,
        submissionOutcome: "accepted",
      });
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
