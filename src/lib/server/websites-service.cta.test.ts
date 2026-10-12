import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { sampleWebsiteConfig } from "@/types/website";

/**
 * updateWebsiteCtaAndRebuild (STL-2): the call-to-action rebuild goes through
 * the same guarded build path as the Build button — the agency gate, the
 * in-flight refusal, the hourly counter, `transitionWebsite` — and adds its
 * own: an https-only link, a site that must still exist, and a site name
 * that must match the id. Real service + real gitpage client over the
 * in-memory Firestore; only the outbound fetch, the QStash publish and the
 * Auth lookup are stubbed.
 */

const mem = createMemoryFirestore();
/** Runs before a document read reaches the store (to interleave a writer). */
const hooks = vi.hoisted(() => ({ beforeGet: null as ((path: string) => Promise<void> | void) | null }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    ...mem.db,
    doc: (path: string) => {
      const ref = mem.db.doc(path);
      return { ...ref, get: async () => (await hooks.beforeGet?.(path), ref.get()) };
    },
  }),
  getAdminAuth: () => ({ getUser: async () => ({ email: "owner@acme.test" }) }),
}));
const publishCallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, publishCallback }));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const {
  safeCtaLink,
  siteDisplayName,
  submitWebsiteBuildForSubAccount,
  updateWebsiteCtaAndRebuild,
  websiteLimitsPath,
  WEBSITE_BUILDS_PER_HOUR,
} = await import("./websites-service");

const SITE = "subAccounts/sa1/website/site1";
const FORM_URL = "https://crm.example.test/f/form1";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL, app: process.env.NEXT_PUBLIC_APP_URL };

const site = (patch: Record<string, unknown> = {}) => ({
  id: "site1", agencyId: "ag1", subAccountId: "sa1", name: "Acme Coffee", status: "ready",
  gitpageJobId: "job_old", liveUrl: "https://acme.gitpage.test/", config: sampleWebsiteConfig(), ...patch,
});
const rebuild = (patch: Partial<Parameters<typeof updateWebsiteCtaAndRebuild>[0]> = {}) =>
  updateWebsiteCtaAndRebuild({ subAccountId: "sa1", siteId: "site1", ctaLink: FORM_URL, buildByUid: "u1", ...patch });
/** Nothing was spent and nothing changed: no call to gitpage, no build counted, the doc as it was. */
const untouched = (before: unknown) => {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mem.read(websiteLimitsPath("sa1"))).toBeUndefined();
  expect(mem.read(SITE)).toEqual(before);
  expect(publishCallback).not.toHaveBeenCalled();
};

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test/";
  hooks.beforeGet = null;
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Acme" });
  mem.seed(SITE, site());
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  let jobs = 0;
  fetchMock.mockReset().mockImplementation(async () => {
    const id = `job_new_${++jobs}`;
    return Response.json({ formResponseId: id, pollUrl: `https://gitpage.test/s/${id}`, estimatedDurationSeconds: 1200 }, { status: 202 });
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

describe("updateWebsiteCtaAndRebuild", () => {
  it("stores the new link, keeps the rest of the config, and submits one build that carries it", async () => {
    const res = await rebuild();
    expect(res).toEqual({ formResponseId: "job_new_1", siteName: "Acme Coffee", ctaLink: FORM_URL, previousCtaLink: "https://sbc.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ ctaLink: FORM_URL, heading: "Starbucks Coffee Chadstone", subAccountId: "sa1" });
    expect(mem.read(SITE)).toMatchObject({
      status: "queued", gitpageJobId: "job_new_1", lastBuildByUid: "u1",
      config: { cta_link: FORM_URL, heading: "Starbucks Coffee Chadstone", hero_statement: "Best Coffee In Melbourne" },
    });
    // The poll for the new job is scheduled, as for any build.
    expect(publishCallback).toHaveBeenCalledTimes(1);
  });

  it.each(["queued", "building"])("is refused while the site is %s: gitpage is not called and no build is counted", async (status) => {
    mem.seed(SITE, site({ status }));
    const before = mem.read(SITE);
    await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("building right now") });
    untouched(before);
  });

  it("counts against the workspace's hourly build limit, and is refused once it is used up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 11, 8, 0, 0));
    await rebuild();
    expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ count: 1 });
    // Nine ordinary builds use the rest of the hour's allowance.
    for (let i = 0; i < WEBSITE_BUILDS_PER_HOUR - 1; i++) {
      await mem.db.doc(SITE).update({ status: "ready" });
      await submitWebsiteBuildForSubAccount({ subAccountId: "sa1", siteId: "site1", config: sampleWebsiteConfig(), buildByUid: "u1" });
    }
    expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ count: WEBSITE_BUILDS_PER_HOUR });
    expect(fetchMock).toHaveBeenCalledTimes(WEBSITE_BUILDS_PER_HOUR);

    await mem.db.doc(SITE).update({ status: "ready" });
    const before = mem.read(SITE);
    await expect(rebuild({ ctaLink: "https://crm.example.test/b/acme" })).rejects.toMatchObject({ status: 429, retryAfterSec: 3600 });
    expect(fetchMock).toHaveBeenCalledTimes(WEBSITE_BUILDS_PER_HOUR);
    expect(mem.read(SITE)).toEqual(before);
  });

  it.each([
    ["http", "http://crm.example.test/f/form1"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["protocol-relative", "//crm.example.test/f/form1"],
    ["no scheme", "crm.example.test/f/form1"],
    ["embedded credentials", "https://user:pass@crm.example.test/f/form1"],
    ["localhost", "https://localhost/f/form1"],
    ["a private IP", "https://10.0.0.5/f/form1"],
    ["an inner space", "https://crm.example.test/f/form1 onclick=x"],
    ["a newline", "https://crm.example.test/f/form1\nhttps://evil.example"],
    ["over 2,048 characters", `https://crm.example.test/f/${"a".repeat(2048)}`],
    ["empty", "   "],
  ])("rejects a link that is %s, before anything is read or spent", async (_what, ctaLink) => {
    const before = mem.read(SITE);
    await expect(rebuild({ ctaLink })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("https://") });
    untouched(before);
  });

  it("accepts an https link of exactly 2,048 characters, and stores it trimmed", async () => {
    const long = `https://crm.example.test/f/${"a".repeat(2048 - "https://crm.example.test/f/".length)}`;
    expect(long).toHaveLength(2048);
    expect(safeCtaLink(long)).toBe(long);
    expect(safeCtaLink(`${long}a`)).toBeNull();
    await rebuild({ ctaLink: `  ${FORM_URL}  ` });
    expect((mem.read(SITE)!.config as { cta_link: string }).cta_link).toBe(FORM_URL);
  });

  describe("tenant anchoring", () => {
    beforeEach(() => {
      mem.seed("subAccounts/sa2", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Other" });
      mem.seed("subAccounts/sa2/website/siteB", site({ id: "siteB", subAccountId: "sa2", name: "Other site" }));
    });

    it("another workspace's site id is not found from this one, and that site is left alone", async () => {
      const theirs = mem.read("subAccounts/sa2/website/siteB");
      await expect(rebuild({ siteId: "siteB" })).rejects.toMatchObject({ status: 404 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mem.read("subAccounts/sa2/website/siteB")).toEqual(theirs);
      expect(mem.read("subAccounts/sa1/website/siteB")).toBeUndefined();
    });

    it("a site doc stamped with another sub-account is not found", async () => {
      mem.seed(SITE, site({ subAccountId: "sa2" }));
      const before = mem.read(SITE);
      await expect(rebuild()).rejects.toMatchObject({ status: 404 });
      untouched(before);
    });

    it.each([
      ["site", { siteId: "../../sa2/website/siteB" }],
      ["site", { siteId: "site1/x/y" }],
      ["sub-account", { subAccountId: "sa2/website/siteB/x" }],
    ])("a path-shaped %s id is not found", async (_what, patch) => {
      await expect(rebuild(patch)).rejects.toMatchObject({ status: 404 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("is refused with the website gate off, like every other build", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: false, name: "Acme" });
    const before = mem.read(SITE);
    await expect(rebuild()).rejects.toMatchObject({ status: 403 });
    untouched(before);
    // The gate answers before the site is looked up: a gated-off workspace learns nothing about its ids.
    await expect(rebuild({ siteId: "nope" })).rejects.toMatchObject({ status: 403 });
  });

  it("is refused without a gitpage key", async () => {
    delete process.env.GITPAGE_API_KEY;
    const before = mem.read(SITE);
    await expect(rebuild()).rejects.toMatchObject({ status: 503 });
    untouched(before);
  });

  it("a site with an incomplete config fails validation, with the field named, and nothing is spent", async () => {
    mem.seed(SITE, site({ status: "draft", config: { ...sampleWebsiteConfig(), heading: "" } }));
    const before = mem.read(SITE);
    await expect(rebuild()).rejects.toMatchObject({ status: 400, fieldErrors: { heading: expect.any(String) } });
    untouched(before);
  });

  it("a site that does not exist is not found — and is not created by the build", async () => {
    await expect(rebuild({ siteId: "nope" })).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.list("subAccounts/sa1/website").map((d) => d.id)).toEqual(["site1"]);
  });

  it("a site removed between this read and the build's own is refused, not re-created", async () => {
    // The gate is read twice: here, then inside the build. Remove the site on the second.
    let gateReads = 0;
    hooks.beforeGet = async (path) => {
      if (path === "subAccounts/sa1" && ++gateReads === 2) await mem.db.doc(SITE).delete();
    };
    await expect(rebuild()).rejects.toMatchObject({ status: 404 });
    expect(gateReads).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(SITE)).toBeUndefined();
    expect(mem.read(websiteLimitsPath("sa1"))).toBeUndefined();
  });

  describe("the site name the person confirmed", () => {
    it("must be the site the id points at", async () => {
      const before = mem.read(SITE);
      await expect(rebuild({ expectSiteName: "Joe's Gym" })).rejects.toMatchObject({
        status: 409, message: expect.stringContaining("belongs to “Acme Coffee”, not “Joe's Gym”"),
      });
      untouched(before);
    });

    it("matches whatever the case or spacing, and falls back to the heading for an unnamed site", async () => {
      await rebuild({ expectSiteName: "  acme   COFFEE " });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      mem.seed(SITE, site({ name: "" }));
      await expect(rebuild({ ctaLink: "https://crm.example.test/b/x", expectSiteName: "Starbucks Coffee Chadstone" })).resolves.toMatchObject({
        siteName: "Starbucks Coffee Chadstone",
      });
    });
  });

  it("a live site that already has the link is not rebuilt; a failed one is", async () => {
    mem.seed(SITE, site({ config: { ...sampleWebsiteConfig(), cta_link: FORM_URL } }));
    const before = mem.read(SITE);
    await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already") });
    untouched(before);

    // The same link stored as typed: an upper-case host, a bare origin with no trailing slash.
    for (const [stored, asked] of [
      ["HTTPS://CRM.Example.TEST/f/form1", FORM_URL],
      ["https://crm.example.test", "https://crm.example.test/"],
    ]) {
      mem.seed(SITE, site({ config: { ...sampleWebsiteConfig(), cta_link: stored } }));
      const unchanged = mem.read(SITE);
      await expect(rebuild({ ctaLink: asked })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("already") });
      untouched(unchanged);
    }

    // A failed build that has settled (no job left to finish).
    mem.seed(SITE, site({ status: "failed", gitpageJobId: null, config: { ...sampleWebsiteConfig(), cta_link: FORM_URL } }));
    await rebuild();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("a failed site whose last build can still finish", () => {
    const unsettled = () =>
      site({ status: "failed", gitpageJobId: "job_old", errorMessage: "Couldn't schedule the next poll. Try Re-check now or Rebuild." });

    it("is refused, as the wizard's draft save refuses it, and nothing is spent", async () => {
      mem.seed(SITE, unsettled());
      const before = mem.read(SITE);
      await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("use Re-check now, or reset it") });
      untouched(before);
    });

    it("is refused at the write too, when the site turns into one while gitpage is called", async () => {
      fetchMock.mockImplementationOnce(async () => {
        await mem.db.doc(SITE).update(unsettled());
        return Response.json({ formResponseId: "job_new_1", pollUrl: "https://gitpage.test/s/job_new_1" }, { status: 202 });
      });
      await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("use Re-check now, or reset it") });
      expect(mem.read(SITE)).toMatchObject({ status: "failed", gitpageJobId: "job_old", config: { cta_link: "https://sbc.com" } });
      expect(publishCallback).not.toHaveBeenCalled();
    });
  });

  it("writes back only the call-to-action: a wizard save that lands meanwhile is kept", async () => {
    // The gate is read twice: here, then inside the build. Save over the site on the second.
    let gateReads = 0;
    hooks.beforeGet = async (path) => {
      if (path === "subAccounts/sa1" && ++gateReads === 2) {
        await mem.db.doc(SITE).set({ config: { hero_statement: "EDITED BY WIZARD" } }, { merge: true });
      }
    };
    await rebuild();
    expect(gateReads).toBe(2);
    expect(mem.read(SITE)).toMatchObject({
      status: "queued",
      config: { cta_link: FORM_URL, hero_statement: "EDITED BY WIZARD", heading: "Starbucks Coffee Chadstone" },
    });
  });
});

describe("submitWebsiteBuildForSubAccount — requireExisting", () => {
  it("refuses a build on an id with no doc, before gitpage is called or a build is counted", async () => {
    await expect(
      submitWebsiteBuildForSubAccount({ subAccountId: "sa1", siteId: "ghost", config: sampleWebsiteConfig(), buildByUid: "u1", requireExisting: true }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(websiteLimitsPath("sa1"))).toBeUndefined();
    expect(mem.read("subAccounts/sa1/website/ghost")).toBeUndefined();
  });
});

describe("siteDisplayName", () => {
  it("is the name, else the heading, else “Untitled site” — on one line, with nothing the assistant's input check refuses", async () => {
    const { hasUnsafeText } = await import("@/lib/ai-suite/capabilities/text-safety");
    expect(siteDisplayName({ name: "Acme\uE000Coffee" })).toBe("AcmeCoffee");
    expect(siteDisplayName({ name: "Acme \u{10FFFF}\u0378 Coffee\n" })).toBe("Acme Coffee");
    expect(siteDisplayName({ name: "", config: { heading: "   " } })).toBe("Untitled site");
    expect(siteDisplayName({ name: " \t", config: { heading: " Joe's  Gym " } })).toBe("Joe's Gym");
    expect(siteDisplayName({ name: "\uE000", config: null })).toBe("Untitled site");
    for (const raw of ["A\uE000B", "A\u200BB", "A\u202EB", "A\uD800B", "A\u0378B", "A\u2800B", "A\u0007B"]) {
      expect(hasUnsafeText(siteDisplayName({ name: raw }))).toBe(false);
    }
  });

  it("a site named with a private-use character can be re-pointed by the name the lookup prints", async () => {
    mem.seed(SITE, site({ name: "Acme\uE000Coffee" }));
    await expect(rebuild({ expectSiteName: "AcmeCoffee" })).resolves.toMatchObject({ siteName: "AcmeCoffee" });
  });
});
