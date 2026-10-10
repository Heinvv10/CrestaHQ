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
  PREMIUM_CLAUDE_MODEL,
  pollBuild,
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
    pageId: "page_42",
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
    expect(result).toMatchObject({ status: "Published", isTerminal: true, pageId: "page_42" });
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
