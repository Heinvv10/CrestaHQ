import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankWebsiteConfig, type WebsiteConfig } from "@/types/website";

/**
 * Agency templates and client sites in the gitpage client (LeadStack
 * 1.0.42): what a template build request carries, and what of gitpage's
 * template / site lists survives to be stored or shown — ids are gitpage
 * ObjectIds, URLs public https, domains plain hostnames. Real client; only
 * the outbound fetch is stubbed.
 */

const { fetchClientSites, fetchTemplates, hideClientSite, removeTemplate, saveTemplate, submitBuild } =
  await import("./client");

const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };
const PAGE = "64b7f0c2a1d3e4f5a6b7c8d9";
const PAGE2 = "64b7f0c2a1d3e4f5a6b7c8da";

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  fetchMock.mockReset().mockImplementation(async () =>
    Response.json({ formResponseId: "build_abc", pollUrl: "https://gitpage.test/s/build_abc" }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const sent = (call = 0) => {
  const [url, init] = fetchMock.mock.calls[call] as [string, { body?: string; method?: string }];
  return { url, method: init.method ?? "GET", body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null };
};

const templateConfig = (patch: Partial<WebsiteConfig> = {}): WebsiteConfig => ({
  ...blankWebsiteConfig(),
  heading: "Should not be sent",
  hero_statement: "Should not be sent",
  color_scheme: "Dark Mode",
  concept: "atelier",
  template_id: PAGE,
  template_name: "Gym template",
  contact_details: "hello@peak.test",
  cta_link: "https://peak.test/book",
  business_details: {
    business_name: " Peak Gym ",
    business_phone: "+27 11 555 0100",
    business_street: "",
    business_city: "Johannesburg",
    business_state: "",
    business_zip: "",
    business_country: "South Africa",
    business_email: "ignored@peak.test",
    google_rating: "",
    google_review_count: "",
    opening_hours: "",
  },
  ...patch,
});

describe("submitBuild — template build", () => {
  it("sends the template's own small payload: no design or copy fields, the business details trimmed, the wiring", async () => {
    await submitBuild({
      config: templateConfig(),
      subAccountId: "sa1",
      subAccountName: "Peak",
      callbackUrl: "https://crm.test/api/webhooks/gitpage/build-settled",
      editorEmail: "owner@peak.test",
      leadstack: {
        appUrl: "https://crm.test",
        subAccountId: "sa1",
        formId: "form1",
        formSubmitUrl: "https://crm.test/api/forms/form1/submit",
        widgetScriptUrl: "https://crm.test/widget.js",
      },
    });
    expect(sent().body).toEqual({
      buildType: "template",
      templateId: PAGE,
      subAccountId: "sa1",
      subAccountName: "Peak",
      callbackUrl: "https://crm.test/api/webhooks/gitpage/build-settled",
      editorEmail: "owner@peak.test",
      businessName: "Peak Gym",
      businessEmail: "hello@peak.test",
      businessPhone: "+27 11 555 0100",
      businessCity: "Johannesburg",
      businessCountry: "South Africa",
      ctaLink: "https://peak.test/book",
      leadstack: {
        appUrl: "https://crm.test",
        subAccountId: "sa1",
        formId: "form1",
        formSubmitUrl: "https://crm.test/api/forms/form1/submit",
        widgetScriptUrl: "https://crm.test/widget.js",
      },
    });
  });

  it("leaves the form out of the wiring when it has no submit URL, and sends no wiring without one", async () => {
    await submitBuild({ config: templateConfig(), subAccountId: "sa1", leadstack: { appUrl: "https://crm.test", subAccountId: "sa1", formId: "form1" } });
    expect(sent().body?.leadstack).toEqual({ appUrl: "https://crm.test", subAccountId: "sa1" });
    await submitBuild({ config: templateConfig(), subAccountId: "sa1" });
    expect(sent(1).body).not.toHaveProperty("leadstack");
  });

  it("a config without a template id is a normal build", async () => {
    await submitBuild({ config: templateConfig({ template_id: null }), subAccountId: "sa1" });
    expect(sent().body).toMatchObject({ buildType: "local", heading: "Should not be sent" });
  });
});

describe("fetchTemplates", () => {
  it("keeps only templates with an ObjectId and a name, with an https preview or none", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      clientTemplates: true,
      templates: [
        { templateId: PAGE, name: " Gym\nsite ", previewUrl: "https://gym.gitlab.io/", quality: "premium", scope: "client" },
        { templateId: PAGE2, name: "Plain", previewUrl: "javascript:alert(1)" },
        { templateId: "../../etc", name: "Path" },
        { templateId: PAGE, name: "" },
        { templateId: `${PAGE}0`, name: "Too long" },
      ],
    }));
    const out = await fetchTemplates("sa1");
    expect(sent().url).toBe("https://gitpage.test/api/v1/templates?subAccountId=sa1");
    expect(out.enabled).toBe(true);
    expect(out.clientTemplates).toBe(true);
    expect(out.templates).toEqual([
      expect.objectContaining({ templateId: PAGE, name: "Gym site", previewUrl: "https://gym.gitlab.io/", quality: "premium", scope: "client" }),
      expect.objectContaining({ templateId: PAGE2, name: "Plain", previewUrl: null, quality: "standard", scope: "agency" }),
    ]);
  });

  it("drops a client template gitpage says belongs to another sub-account; keeps one without an owner", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      clientTemplates: true,
      templates: [
        { templateId: PAGE, name: "Theirs", scope: "client", subAccountId: "sa2" },
        { templateId: PAGE2, name: "Mine", scope: "client", subAccountId: "sa1" },
        { templateId: "64b7f0c2a1d3e4f5a6b7c8db", name: "Unowned", scope: "client" },
        { templateId: "64b7f0c2a1d3e4f5a6b7c8dc", name: "Agency", scope: "agency", subAccountId: "sa2" },
      ],
    }));
    expect((await fetchTemplates("sa1")).templates.map((t) => t.name)).toEqual(["Mine", "Unowned", "Agency"]);
  });

  it("404 is 'not available', any other failure throws with gitpage's message", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Not found" }, { status: 404 }));
    expect(await fetchTemplates("sa1")).toEqual({ enabled: false, templates: [], clientTemplates: false });
    fetchMock.mockResolvedValueOnce(Response.json({ message: "Key revoked" }, { status: 401 }));
    await expect(fetchTemplates("sa1")).rejects.toMatchObject({ message: "Key revoked", status: 401 });
  });
});

describe("saveTemplate / removeTemplate / hideClientSite", () => {
  it("a client save acts as the client; an owner's save carries the scope", async () => {
    fetchMock.mockImplementation(async () => Response.json({ template: { templateId: PAGE, name: "T", scope: "client" } }));
    await saveTemplate(PAGE, "T", { client: "sa1", scope: "agency" });
    expect(sent(0).body).toEqual({ pageId: PAGE, name: "T", actingAs: "client", subAccountId: "sa1" });
    await saveTemplate(PAGE, "T", { scope: "agency" });
    expect(sent(1).body).toEqual({ pageId: PAGE, name: "T", scope: "agency" });
    await removeTemplate(PAGE, "sa1");
    expect(sent(2)).toMatchObject({ method: "DELETE", body: { pageId: PAGE, actingAs: "client", subAccountId: "sa1" } });
    await hideClientSite(PAGE, "sa1", "replaced");
    expect(sent(3)).toMatchObject({ url: "https://gitpage.test/api/v1/sites", body: { action: "hide", pageId: PAGE, subAccountId: "sa1", reason: "replaced" } });
  });
});

describe("fetchClientSites", () => {
  it("drops a site whose pageId is not an ObjectId, and nulls a live URL or domain that is not safe", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      sites: [
        { pageId: PAGE, status: "Published", liveUrl: "https://copy.gitlab.io/", customDomain: "WWW.Peak.Test", origin: "duplicate", duplicatedFrom: PAGE2, repoName: "peak-copy" },
        { pageId: PAGE2, status: "Published", liveUrl: "http://copy.gitlab.io/", customDomain: "peak.test/evil", origin: "duplicate", duplicatedFrom: "../x" },
        { pageId: "gp-../../x", status: "Published", liveUrl: "https://x.gitlab.io/", origin: "duplicate" },
        { pageId: PAGE, liveUrl: `https://x.gitlab.io/${"a".repeat(2100)}` },
        { pageId: PAGE, liveUrl: "https://127.0.0.1/" },
      ],
    }));
    const out = await fetchClientSites("sa1");
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ pageId: PAGE, liveUrl: "https://copy.gitlab.io/", customDomain: "www.peak.test", duplicatedFrom: PAGE2, origin: "duplicate", repoName: "peak-copy" });
    expect(out[1]).toMatchObject({ pageId: PAGE2, liveUrl: null, customDomain: null, duplicatedFrom: null });
    expect(out[2].liveUrl).toBeNull();
    expect(out[3].liveUrl).toBeNull();
  });
});
