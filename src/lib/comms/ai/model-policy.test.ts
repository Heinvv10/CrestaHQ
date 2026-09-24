import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency model allow-list: pure verdicts, the "in use + default" starting
 * policy, and REQUEST-TIME fallback through resolveAgent() — the one seam every
 * live reply reads its model through. Real code over in-memory Firestore; the
 * catalog is seeded fresh so no fetch happens (fetch is stubbed to fail loudly).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { evaluateModel, getEffectiveModelPolicy, resolveRuntimeModel, checkModelForSave, listPickableModels } =
  await import("./model-policy");
const { resolveAgent } = await import("./agent");

const DEFAULT = "anthropic/claude-haiku-4-5";
const SA = "sa1";
const cat = (...ids: string[]) =>
  ids.map((id) => ({ id, name: id, promptPerM: id === "pricey/model" ? 15 : 1, completionPerM: id === "pricey/model" ? 75 : 5 }));
const warn = vi.fn();

function seedCatalog(...ids: string[]) {
  mem.seed("appConfig/aiModels", { models: cat(...ids), fetchedAt: Date.now() });
}
function seedChannel(sa: string, channel: string, modelOverride: string | null) {
  mem.seed(`subAccounts/${sa}/aiAgent/${channel}`, { enabled: true, contextMessageCount: 10, modelOverride });
}

beforeEach(() => {
  mem.clear();
  delete process.env.AI_REPLIES_DEFAULT_MODEL;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  warn.mockReset();
  vi.spyOn(console, "warn").mockImplementation(warn);
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "One" });
  mem.seed(`subAccounts/${SA}/aiAgent/profile`, { systemPrompt: "hi", businessName: "One", escalationKeywords: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("evaluateModel", () => {
  const catalog = { models: cat("a/one", "pricey/model"), fetchedAt: 0 };
  const policy = { allowedModels: ["a/one", "pricey/model"], maxPromptPerM: 10, maxCompletionPerM: null };

  it("allows the app default unconditionally", () => {
    expect(evaluateModel(DEFAULT, { catalog, policy, defaultModel: DEFAULT })).toEqual({ ok: true });
  });
  it("rejects a model OpenRouter no longer lists", () => {
    expect(evaluateModel("gone/model", { catalog, policy: null, defaultModel: DEFAULT })).toEqual({ ok: false, reason: "retired" });
  });
  it("never calls a model retired when there is no catalog yet", () => {
    expect(evaluateModel("gone/model", { catalog: null, policy: null, defaultModel: DEFAULT })).toEqual({ ok: true });
  });
  it("rejects a listed model the agency hasn't allowed", () => {
    expect(evaluateModel("a/one", { catalog, policy: { ...policy, allowedModels: [] }, defaultModel: DEFAULT }))
      .toEqual({ ok: false, reason: "not_allowed" });
  });
  it("rejects an allowed model above the price ceiling", () => {
    expect(evaluateModel("pricey/model", { catalog, policy, defaultModel: DEFAULT })).toEqual({ ok: false, reason: "over_price" });
    expect(evaluateModel("a/one", { catalog, policy, defaultModel: DEFAULT })).toEqual({ ok: true });
  });
});

describe("unsaved policy = models in use + default", () => {
  it("collects every channel's override across the agency's sub-accounts, and only that agency", async () => {
    seedChannel(SA, "sms", "a/one");
    seedChannel(SA, "voice", null);
    mem.seed("subAccounts/sa2", { agencyId: "ag1" });
    seedChannel("sa2", "web-chat", "b/two");
    mem.seed("subAccounts/other", { agencyId: "ag2" });
    seedChannel("other", "sms", "c/three");

    const { policy, saved } = await getEffectiveModelPolicy("ag1");
    expect(saved).toBe(false);
    expect([...policy.allowedModels].sort()).toEqual([DEFAULT, "a/one", "b/two"].sort());
  });
});

describe("save-time check", () => {
  it("refuses a model outside the saved allow-list and accepts one on it", async () => {
    seedCatalog("a/one", "b/two");
    mem.seed("agencies/ag1", { aiModelPolicy: { allowedModels: ["a/one"], maxPromptPerM: null, maxCompletionPerM: null } });
    expect(await checkModelForSave("ag1", "b/two")).toMatch(/not on your agency's allowed model list/);
    expect(await checkModelForSave("ag1", "a/one")).toBeNull();
  });

  it("pickable list = catalog ∩ allow-list, excluding the default", async () => {
    seedCatalog("a/one", "b/two", DEFAULT);
    mem.seed("agencies/ag1", { aiModelPolicy: { allowedModels: ["a/one", DEFAULT], maxPromptPerM: null, maxCompletionPerM: null } });
    const out = await listPickableModels("ag1");
    expect(out.defaultModel).toBe(DEFAULT);
    expect(out.models.map((m) => m.id)).toEqual(["a/one"]);
  });
});

describe("request-time fallback via resolveAgent", () => {
  it("keeps an allowed, listed model", async () => {
    seedCatalog("a/one");
    seedChannel(SA, "sms", "a/one");
    const agent = await resolveAgent(SA, "sms");
    expect(agent?.effective.modelOverride).toBe("a/one");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the app default with a warning when the stored model has retired", async () => {
    seedCatalog("a/one");
    seedChannel(SA, "sms", "gone/model");
    const agent = await resolveAgent(SA, "sms");
    expect(agent?.effective.modelOverride).toBe(DEFAULT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gone/model"));
  });

  it("falls back when the agency no longer allows the stored model", async () => {
    seedCatalog("a/one", "b/two");
    seedChannel(SA, "web-chat", "b/two");
    mem.seed("agencies/ag1", { aiModelPolicy: { allowedModels: ["a/one"], maxPromptPerM: null, maxCompletionPerM: null } });
    const agent = await resolveAgent(SA, "web-chat");
    expect(agent?.effective.modelOverride).toBe(DEFAULT);
  });

  it("honours AI_REPLIES_DEFAULT_MODEL as the fallback target", async () => {
    process.env.AI_REPLIES_DEFAULT_MODEL = "x/deploy-default";
    seedCatalog("a/one");
    expect(await resolveRuntimeModel(SA, "gone/model")).toBe("x/deploy-default");
  });

  it("leaves a blank override as null (the default) and never fails the reply when the check errors", async () => {
    expect(await resolveRuntimeModel(SA, null)).toBeNull();
    // No catalog and fetch fails -> unknown, not retired: stored model kept.
    expect(await resolveRuntimeModel(SA, "a/one")).toBe("a/one");
  });
});
