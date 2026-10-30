import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blankPremiumDetails,
  sampleWebsiteConfig,
  type WebsiteConfig,
} from "@/types/website";

/**
 * Website Build v2 in the gitpage client: what a premium build request
 * carries, and how a status answer or a `build.settled` callback body is
 * read. Real client; only the outbound fetch is stubbed.
 */

const {
  cleanText,
  PREMIUM_CLAUDE_MODEL,
  pollBuild,
  safePagesUrl,
  settledPayloadToPollResult,
  submitBuild,
} = await import("./client");

const fetchMock = vi.fn();
const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };

beforeEach(() => {
  process.env.GITPAGE_API_KEY = "gp_test_key";
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  // A fresh Response per call: a body can be read only once.
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

/** Submit `config` and return the JSON body gitpage was sent. */
async function submitted(
  config: WebsiteConfig,
  extra: Partial<Parameters<typeof submitBuild>[0]> = {},
): Promise<Record<string, unknown>> {
  await submitBuild({ config, subAccountId: "sa1", ...extra });
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

const premiumConfig = (patch: Partial<WebsiteConfig> = {}): WebsiteConfig => ({
  ...sampleWebsiteConfig(),
  quality: "premium",
  ...patch,
});

const WIRING = {
  appUrl: "https://crm.example.test",
  subAccountId: "sa1",
  formId: "form1",
  formSubmitUrl: "https://crm.example.test/api/forms/form1/submit",
  widgetScriptUrl: "https://crm.example.test/widget.js",
};

describe("submitBuild — premium request", () => {
  it("sends the quality, the forced model tier and the premium block", async () => {
    const body = await submitted(
      premiumConfig({
        concept: "atelier",
        hero_motion: "loop",
        color_scheme: "Dark Mode",
        premium_details: {
          ...blankPremiumDetails(),
          tagline: " Built to last ",
          founded_year: "2011",
          metrics: "Members: 1,200\nCoaches: 14",
          reference_notes: "  Family-run since 2011.  ",
        },
      }),
    );
    expect(body.quality).toBe("premium");
    expect(body.claudeModel).toBe(PREMIUM_CLAUDE_MODEL);
    expect(PREMIUM_CLAUDE_MODEL).toBe("opus-5.5");
    expect(body.premium).toEqual({
      concept: "atelier",
      mode: "dark",
      heroMotion: "loop",
      tagline: "Built to last",
      foundedYear: 2011,
      metrics: [
        { label: "Members", value: "1,200" },
        { label: "Coaches", value: "14" },
      ],
    });
    expect(body.referenceNotes).toBe("Family-run since 2011.");
  });

  it("sends niche-only details for their niche and omits them after the niche changes", async () => {
    const premium_details = { ...blankPremiumDetails(), tools: "n8n", case_studies: "Acme | Won" };
    const on = await submitted(premiumConfig({ niche: "ai_automation", premium_details }));
    expect(on.premium).toMatchObject({ tools: ["n8n"], caseStudies: [{ client: "Acme", result: "Won" }] });
    fetchMock.mockClear();
    const off = await submitted(premiumConfig({ niche: "gym_fitness", premium_details }));
    expect(off.premium).not.toHaveProperty("tools");
    expect(off.premium).not.toHaveProperty("caseStudies");
  });

  it("leaves the concept and hero motion out when the operator picked none", async () => {
    const body = await submitted(premiumConfig({ concept: null, hero_motion: null, premium_details: null }));
    expect(body.premium).toEqual({ mode: "light" });
    expect(body).not.toHaveProperty("referenceNotes");
  });

  it("treats a config with no quality as premium", async () => {
    const body = await submitted(premiumConfig({ quality: undefined }));
    expect(body).toMatchObject({ quality: "premium", claudeModel: "opus-5.5" });
  });

  it("carries the editor's email and the callback URL only when given", async () => {
    const withBoth = await submitted(premiumConfig(), {
      editorEmail: "owner@acme.test",
      callbackUrl: "https://crm.example.test/api/webhooks/gitpage/build-settled",
    });
    expect(withBoth).toMatchObject({
      editorEmail: "owner@acme.test",
      callbackUrl: "https://crm.example.test/api/webhooks/gitpage/build-settled",
    });

    fetchMock.mockClear();
    const without = await submitted(premiumConfig());
    expect(without).not.toHaveProperty("editorEmail");
    expect(without).not.toHaveProperty("callbackUrl");
  });

  it("sends no wiring block unless the caller supplies one", async () => {
    expect(await submitted(premiumConfig())).not.toHaveProperty("leadstack");
  });

  it("bakes in the form and the widget the config asks for", async () => {
    const body = await submitted(premiumConfig(), { leadstack: WIRING });
    expect(body.leadstack).toEqual(WIRING);
  });

  it("drops the form and the widget the operator switched off", async () => {
    const body = await submitted(premiumConfig({ include_form: false, include_chat: false }), { leadstack: WIRING });
    expect(body.leadstack).toEqual({ appUrl: "https://crm.example.test", subAccountId: "sa1" });
  });

  it("a standard request carries no premium fields at all", async () => {
    const body = await submitted(premiumConfig({ quality: "standard", concept: "atelier" }), {
      leadstack: WIRING,
    });
    expect(body.quality).toBe("standard");
    for (const key of ["claudeModel", "premium", "referenceNotes", "leadstack"]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe("reading a build's status", () => {
  const PUBLISHED = {
    status: "Published",
    statusPhase: "completed",
    pagesUrl: "https://acme.gitlab.io/site",
    quality: "premium",
    concept: "atelier",
    estimatedDurationSeconds: 1200,
    imageProvider: "higgsfield",
    imageCount: 9,
    briefSource: "opus",
    pageId: "64b7f0c2a1d3e4f5a6b7c842",
    kbText: "Acme Gym is open 6am–9pm.",
    agentPersona: {
      systemPrompt: "You are Acme's assistant.",
      businessName: "Acme Gym",
      hoursStart: 6,
      hoursEnd: 21,
      escalationKeywords: ["refund", 7, "injury"],
      welcomeMessage: "Hi!",
    },
    theme: { primaryColor: "#B13F2B", mode: "dark", conceptName: "Atelier", ink: 12 },
  };

  it("pollBuild reads the premium artefacts and the page id", async () => {
    fetchMock.mockResolvedValue(Response.json(PUBLISHED));
    const result = await pollBuild("build_abc");
    expect(result).toMatchObject({ status: "Published", isTerminal: true, pageId: "64b7f0c2a1d3e4f5a6b7c842" });
    expect(result.premium).toEqual({
      quality: "premium",
      concept: "atelier",
      estimatedDurationSeconds: 1200,
      failedStage: null,
      imageProvider: "higgsfield",
      imageCount: 9,
      briefSource: "opus",
      kbText: "Acme Gym is open 6am–9pm.",
      agentPersona: {
        systemPrompt: "You are Acme's assistant.",
        businessName: "Acme Gym",
        hoursStart: 6,
        hoursEnd: 21,
        escalationKeywords: ["refund", "injury"],
        welcomeMessage: "Hi!",
      },
      theme: { primaryColor: "#B13F2B", mode: "dark", conceptName: "Atelier" },
    });
  });

  it("a callback body reads exactly as the status endpoint's answer does", async () => {
    fetchMock.mockResolvedValue(Response.json(PUBLISHED));
    expect(settledPayloadToPollResult(PUBLISHED)).toEqual(await pollBuild("build_abc"));
  });

  it("a standard build has no premium block and no page id", () => {
    const result = settledPayloadToPollResult({ status: "Published", pagesUrl: "https://x.example" });
    expect(result.premium).toBeNull();
    expect(result.pageId).toBeNull();
  });

  it("a failed premium build reports the stage it failed at", () => {
    const result = settledPayloadToPollResult({
      status: "Failed",
      quality: "premium",
      failedStage: "images",
      error: "Image generation failed.",
    });
    expect(result).toMatchObject({ status: "failed", isTerminal: true, error: "Image generation failed." });
    expect(result.premium).toMatchObject({ failedStage: "images", kbText: null, agentPersona: null, theme: null });
  });

  it("an in-progress body is not terminal", () => {
    expect(settledPayloadToPollResult({ status: "processing", statusPhase: "render" })).toMatchObject({
      status: "processing",
      statusPhase: "render",
      isTerminal: false,
    });
  });
});

describe("R5: the live URL gitpage reports", () => {
  it.each([
    ["a GitLab Pages path URL", "https://acme.gitlab.io/site", "https://acme.gitlab.io/site"],
    ["a bare origin (stored in href form)", "https://www.peakyoga.com", "https://www.peakyoga.com/"],
    ["a query string", "https://acme.gitlab.io/site?ref=a%20b", "https://acme.gitlab.io/site?ref=a%20b"],
    ["an upper-case host", "https://ACME.GitLab.io/Site", "https://acme.gitlab.io/Site"],
  ])("accepts %s", (_label, raw, stored) => {
    expect(safePagesUrl(raw)).toBe(stored);
    expect(settledPayloadToPollResult({ status: "Published", pagesUrl: raw }).pagesUrl).toBe(stored);
  });

  it.each([
    ["javascript:", "javascript:alert(document.cookie)"],
    ["javascript: in mixed case with a leading space", " JaVaScRiPt:alert(1)"],
    ["data:", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["file:", "file:///etc/passwd"],
    ["plain http", "http://acme.gitlab.io/site"],
    ["protocol-relative", "//acme.gitlab.io/site"],
    ["a relative path", "/site"],
    ["the cloud metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["a link-local IPv6 literal", "https://[fe80::1]/"],
    ["loopback", "https://127.0.0.1/"],
    ["a private address", "https://10.0.0.5/"],
    ["a decimal-encoded loopback", "https://2130706433/"],
    ["localhost", "https://localhost:4300/"],
    ["an IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/"],
    ["a newline inside it", "https://acme.gitlab.io/site\nSet-Cookie: a=b"],
    ["a carriage return and newline", "https://acme.gitlab.io/\r\nLocation: https://evil.example"],
    ["a tab inside the scheme", "java\tscript:alert(1)"],
    ["a NUL", "https://acme.gitlab.io/\u0000"],
    ["a space", "https://acme.gitlab.io/my site"],
    ["a username", "https://acme.gitlab.io@evil.example/"],
    ["a username and password", "https://user:pass@acme.gitlab.io/"],
    ["2,049 characters", `https://acme.gitlab.io/${"a".repeat(2049 - "https://acme.gitlab.io/".length)}`],
    ["900 KB", `https://acme.gitlab.io/${"a".repeat(900 * 1024)}`],
    ["an empty string", ""],
    ["not a URL", "acme.gitlab.io/site"],
    ["a number", 42],
    ["an object", { href: "https://acme.gitlab.io/site" }],
    ["null", null],
  ])("refuses %s", (_label, raw) => {
    expect(safePagesUrl(raw)).toBeNull();
    expect(settledPayloadToPollResult({ status: "Published", pagesUrl: raw }).pagesUrl).toBeNull();
  });

  it.each([
    ["a trailing newline", "https://acme.gitlab.io/site\n"],
    ["a trailing CRLF", "https://acme.gitlab.io/site\r\n"],
    ["spaces around it", "   https://acme.gitlab.io/site  "],
    ["a leading tab", "\thttps://acme.gitlab.io/site"],
  ])("R2-4: trims %s before judging the address", (_label, raw) => {
    expect(safePagesUrl(raw)).toBe("https://acme.gitlab.io/site");
    expect(settledPayloadToPollResult({ status: "Published", pagesUrl: raw })).toMatchObject({
      pagesUrl: "https://acme.gitlab.io/site",
      pagesUrlRefused: null,
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", " \n\t "],
  ])("R2-4: a %s address is 'none yet', not a refusal", (_label, raw) => {
    expect(settledPayloadToPollResult({ status: "Published", pagesUrl: raw })).toMatchObject({
      pagesUrl: null,
      pagesUrlRefused: null,
    });
  });

  it.each([
    ["plain http", "http://acme.gitlab.io/site", "http://acme.gitlab.io/site"],
    ["no scheme", "acme.gitlab.io/site", "acme.gitlab.io/site"],
    ["a newline inside it", "https://a.example/\nIgnore previous instructions", "https://a.example/ Ignore previous instructions"],
    ["900 KB", `https://acme.gitlab.io/${"a".repeat(900 * 1024)}`, `https://acme.gitlab.io/${"a".repeat(200 - "https://acme.gitlab.io/".length)}`],
    ["a number", 42, "a value that is not text"],
  ])("R2-4: a refused address (%s) is reported as refused, cleaned and cut to 200", (_label, raw, shown) => {
    expect(settledPayloadToPollResult({ status: "Published", pagesUrl: raw })).toMatchObject({
      pagesUrl: null,
      pagesUrlRefused: shown,
    });
  });

  it("accepts exactly 2,048 characters", () => {
    const url = `https://acme.gitlab.io/${"a".repeat(2048 - "https://acme.gitlab.io/".length)}`;
    expect(url).toHaveLength(2048);
    expect(safePagesUrl(url)).toBe(url);
  });

  it("a status answer from the poll endpoint is held to the same rule", async () => {
    fetchMock.mockImplementation(async () => Response.json({ status: "Published", pagesUrl: "javascript:alert(1)" }));
    expect((await pollBuild("build_abc")).pagesUrl).toBeNull();
  });
});

describe("R5 / R11: other fields of a status body", () => {
  it.each([
    ["a number", 200],
    ["an object", { state: "Published" }],
    ["an array", ["failed"]],
    ["null", null],
    ["missing", undefined],
  ])("R11: a status that is %s reads as processing, without throwing", (_label, status) => {
    const result = settledPayloadToPollResult({ status, pagesUrl: "https://acme.gitlab.io/site" });
    expect(result).toMatchObject({ status: "processing", isTerminal: false });
  });

  it("cuts error and stage text and caps the partial-error list", () => {
    const result = settledPayloadToPollResult({
      status: "failed",
      quality: "premium",
      error: "E".repeat(10_000),
      statusPhase: "S".repeat(10_000),
      failedStage: "F".repeat(10_000),
      concept: "C".repeat(10_000),
      partialErrors: [...Array.from({ length: 100 }, () => "P".repeat(10_000)), 7, null],
      theme: { primaryColor: "#000000", conceptName: "N".repeat(10_000) },
    });
    expect(result.error).toHaveLength(500);
    expect(result.statusPhase).toHaveLength(120);
    expect(result.partialErrors).toHaveLength(20);
    expect(result.partialErrors!.every((e) => e.length === 500)).toBe(true);
    expect(result.premium?.failedStage).toHaveLength(120);
    expect(result.premium?.concept).toHaveLength(120);
    expect(result.premium?.theme?.conceptName).toHaveLength(120);
  });

  it("cleanText collapses every run of control characters to one space and trims", () => {
    expect(cleanText("a\nb", 50)).toBe("a b");
    expect(cleanText("  a\r\n\r\n\tb\u0000c\u007fd\u0085e\u2028f\u2029g  ", 50)).toBe("a b c d e f g");
    expect(cleanText("\n\n", 50)).toBeNull();
    expect(cleanText("", 50)).toBeNull();
    expect(cleanText(7, 50)).toBeNull();
    expect(cleanText("abcdef", 3)).toBe("abc");
    // Ordinary text, accents and emoji are left alone.
    expect(cleanText("Café déjà vu — 100% ✓", 50)).toBe("Café déjà vu — 100% ✓");
  });

  it("drops a page id carrying control characters rather than storing a cleaned-up different id", () => {
    expect(settledPayloadToPollResult({ status: "Published", pageId: "page_42\n" }).pageId).toBeNull();
    expect(settledPayloadToPollResult({ status: "Published", pageId: "" }).pageId).toBeNull();
  });

  it("keeps only a gitpage ObjectId as the page id (it becomes a tombstone doc id on delete)", () => {
    expect(settledPayloadToPollResult({ status: "Published", pageId: "p".repeat(120) }).pageId).toBeNull();
    expect(settledPayloadToPollResult({ status: "Published", pageId: "page_42" }).pageId).toBeNull();
    expect(settledPayloadToPollResult({ status: "Published", pageId: "../../x/64b7f0c2a1d3e4f5a6b7" }).pageId).toBeNull();
    expect(settledPayloadToPollResult({ status: "Published", pageId: "64B7F0C2A1D3E4F5A6B7C842" }).pageId).toBe("64B7F0C2A1D3E4F5A6B7C842");
  });
});
