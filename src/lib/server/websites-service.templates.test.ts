import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { validateWebsiteConfig } from "@/lib/website/validation";
import { blankWebsiteConfig, sampleWebsiteConfig, type WebsiteConfig } from "@/types/website";

/**
 * Agency template builds in the website service (LeadStack 1.0.42): the
 * config a template build is normalised and validated to, the server-side
 * check that the template is one gitpage offers THIS sub-account (not
 * upstream — client A must not build from client B's client template by
 * id), gitpage's missing-details answer as field errors, the replaced site
 * recorded for the settle to hide, and the CTA rebuild refusals. Real
 * service + real gitpage client over the in-memory Firestore; only the
 * outbound fetch, the QStash publish and the Auth lookup are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async () => ({ email: "owner@acme.test" }) }),
}));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => true, publishCallback: async () => ({ messageId: "m1" }) }));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));
vi.mock("@/lib/server/app-url", () => ({ resolvedAppUrl: async () => null }));

const { normalizeWebsiteConfig, submitWebsiteBuildForSubAccount, updateWebsiteCtaAndRebuild, websiteLimitsPath } =
  await import("./websites-service");

const SITE = "subAccounts/sa1/website/site1";
const TPL = "64b7f0c2a1d3e4f5a6b7c8d9";
const OTHER_CLIENTS_TPL = "64b7f0c2a1d3e4f5a6b7c8da";
const OLD_PAGE = "64b7f0c2a1d3e4f5a6b7c8db";
const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL, app: process.env.NEXT_PUBLIC_APP_URL };
let offered: unknown;
let submitAnswer: () => Response;

const templateConfig = (patch: Partial<WebsiteConfig> = {}): WebsiteConfig => ({
  ...blankWebsiteConfig(),
  template_id: TPL,
  template_name: "Gym template",
  contact_details: "hello@peak.test",
  business_details: { ...sampleWebsiteConfig().business_details!, business_name: "Peak Gym" },
  ...patch,
});
const build = (config: WebsiteConfig) =>
  submitWebsiteBuildForSubAccount({ subAccountId: "sa1", siteId: "site1", config, buildByUid: "u1" });
const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(path));

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test/";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: true, name: "Acme" });
  mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "ready", gitpageJobId: "job_old", gitpagePageId: OLD_PAGE, importedFrom: "gitpage", config: blankWebsiteConfig() });
  offered = { clientTemplates: true, templates: [{ templateId: TPL, name: "Gym template", scope: "agency" }] };
  submitAnswer = () => Response.json({ formResponseId: "job_new", pollUrl: "https://gitpage.test/s/job_new" }, { status: 202 });
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url.includes("/api/v1/templates")) return offered instanceof Response ? offered : Response.json(offered);
    return submitAnswer();
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url], ["NEXT_PUBLIC_APP_URL", ORIGINAL.app]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("validateWebsiteConfig — template build", () => {
  it("asks only for the template, the contact email and the business name", () => {
    expect(validateWebsiteConfig(templateConfig())).toEqual({});
    expect(validateWebsiteConfig(templateConfig({ template_id: "nope", contact_details: "x", cta_link: "ftp://x", business_details: null }))).toEqual({
      template_id: "Pick a template.",
      contact_details: "Must be a valid email address.",
      cta_link: "Must start with http:// or https://.",
      business_details: "Add the business details.",
    });
    const longName = templateConfig({ business_details: { ...templateConfig().business_details!, business_name: "x".repeat(121) } });
    expect(validateWebsiteConfig(longName)).toEqual({ "business_details.business_name": "Max 120 characters." });
    const noName = templateConfig({ business_details: { ...templateConfig().business_details!, business_name: "  " } });
    expect(validateWebsiteConfig(noName)).toEqual({ "business_details.business_name": "Required." });
  });
});

describe("normalizeWebsiteConfig — template branch", () => {
  it("refuses an id that is not a gitpage ObjectId", () => {
    expect(() => normalizeWebsiteConfig(templateConfig({ template_id: "../../x" }))).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("forces a local build with the contact page, the wiring on, no niche, and the business name as the heading", () => {
    const config = templateConfig({ template_id: ` ${TPL} `, niche: "gym_fitness", build_type: "vsl", include_form: false, include_chat: false, local_page_selections: { index: false as unknown as true, services: true, contact: false, privacy: false, terms: true } });
    normalizeWebsiteConfig(config);
    expect(config).toMatchObject({
      template_id: TPL, build_type: "local", niche: null, heading: "Peak Gym", include_form: true, include_chat: true,
      local_page_selections: { index: true, services: true, contact: true, privacy: false, terms: true },
    });
  });

  it("drops the template leftovers when a draft switched away from a template", () => {
    const config = { ...sampleWebsiteConfig(), template_id: "", template_name: "Old" };
    normalizeWebsiteConfig(config);
    expect(config).toMatchObject({ template_id: null, template_name: null });
  });
});

describe("submitWebsiteBuildForSubAccount — template scope (not upstream)", () => {
  it("builds from a template gitpage offers this sub-account, sending the template payload", async () => {
    await build(templateConfig());
    expect(calls("/api/v1/templates")[0][0]).toBe("https://gitpage.test/api/v1/templates?subAccountId=sa1");
    const [, init] = calls("/api/v1/generate-site")[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ buildType: "template", templateId: TPL, businessName: "Peak Gym", subAccountId: "sa1" });
    // The live site it replaces is recorded for the settle to hide; a rebuilt import is a LeadStack build now.
    expect(mem.read(SITE)).toMatchObject({ status: "queued", gitpagePageId: null, replacesGitpagePageId: OLD_PAGE, importedFrom: null });
  });

  it("refuses a template id gitpage does not offer this sub-account: gitpage is not asked to build and no build is counted", async () => {
    const before = mem.read(SITE);
    await expect(build(templateConfig({ template_id: OTHER_CLIENTS_TPL }))).rejects.toMatchObject({
      status: 400,
      fieldErrors: { template_id: expect.stringContaining("Pick the template again") },
    });
    expect(calls("/api/v1/generate-site")).toHaveLength(0);
    expect(mem.read(websiteLimitsPath("sa1"))).toBeUndefined();
    expect(mem.read(SITE)).toEqual(before);
  });

  it("refuses when templates are not switched on (gitpage 404)", async () => {
    offered = Response.json({ error: "Not found" }, { status: 404 });
    await expect(build(templateConfig())).rejects.toMatchObject({ status: 400 });
    expect(calls("/api/v1/generate-site")).toHaveLength(0);
  });

  it("fails closed when gitpage cannot list the templates", async () => {
    offered = Response.json({ error: "boom" }, { status: 500 });
    await expect(build(templateConfig())).rejects.toMatchObject({ status: 502, submissionOutcome: "not-accepted" });
    expect(calls("/api/v1/generate-site")).toHaveLength(0);
    expect(mem.read(websiteLimitsPath("sa1"))).toBeUndefined();
  });

  it("a rebuild of a site whose last build failed keeps the site it still replaces", async () => {
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "failed", gitpageJobId: null, gitpagePageId: null, replacesGitpagePageId: OLD_PAGE, config: blankWebsiteConfig() });
    await build(templateConfig());
    expect(mem.read(SITE)).toMatchObject({ status: "queued", replacesGitpagePageId: OLD_PAGE });
  });

  it("refuses a first build at a gp-<pageId> id: only the gitpage import creates those", async () => {
    const id = `gp-${OTHER_CLIENTS_TPL}`;
    await expect(
      submitWebsiteBuildForSubAccount({ subAccountId: "sa1", siteId: id, config: sampleWebsiteConfig(), buildByUid: "u1" }),
    ).rejects.toMatchObject({ status: 400, submissionOutcome: "not-accepted" });
    expect(mem.read(`subAccounts/sa1/website/${id}`)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.read(websiteLimitsPath("sa1"))).toBeUndefined();
  });

  it("…but rebuilds an imported gp- site that exists", async () => {
    const id = `gp-${OLD_PAGE}`;
    mem.seed(`subAccounts/sa1/website/${id}`, { id, agencyId: "ag1", subAccountId: "sa1", status: "ready", importedFrom: "gitpage", importedPageId: OLD_PAGE, gitpagePageId: OLD_PAGE, config: blankWebsiteConfig() });
    await submitWebsiteBuildForSubAccount({ subAccountId: "sa1", siteId: id, config: sampleWebsiteConfig(), buildByUid: "u1" });
    expect(mem.read(`subAccounts/sa1/website/${id}`)).toMatchObject({ status: "queued", importedFrom: null, importedPageId: OLD_PAGE, replacesGitpagePageId: OLD_PAGE });
  });

  it("a normal build never asks for the template list", async () => {
    await build(sampleWebsiteConfig());
    expect(calls("/api/v1/templates")).toHaveLength(0);
    expect(calls("/api/v1/generate-site")).toHaveLength(1);
  });

  it("turns gitpage's missing-details answer into the wizard's field errors", async () => {
    submitAnswer = () => Response.json({ error: "Missing business details", missing: ["businessPhone", "ctaLink", "unknownField"] }, { status: 400 });
    await expect(build(templateConfig())).rejects.toMatchObject({
      status: 400,
      fieldErrors: {
        "business_details.business_phone": expect.stringContaining("template shows this"),
        cta_link: expect.stringContaining("template shows this"),
      },
    });
  });
});

describe("updateWebsiteCtaAndRebuild — refusals", () => {
  const rebuild = () =>
    updateWebsiteCtaAndRebuild({ subAccountId: "sa1", siteId: "site1", ctaLink: "https://crm.example.test/f/form1", buildByUid: "u1" });

  it("refuses a site copied in gitpage, spending nothing", async () => {
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "ready", importedFrom: "gitpage", config: sampleWebsiteConfig() });
    await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("copied in gitpage") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a site built from an Agency template, spending nothing", async () => {
    mem.seed(SITE, { id: "site1", agencyId: "ag1", subAccountId: "sa1", status: "ready", config: templateConfig() });
    await expect(rebuild()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Agency template") });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
