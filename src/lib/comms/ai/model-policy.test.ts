import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency model allow-list: pure verdicts, the "in use + default" starting
 * policy, and REQUEST-TIME fallback through resolveAgent() — the one seam every
 * live reply reads its model through. Real code over in-memory Firestore;
 * fetch is stubbed to fail — the OpenRouter API is never called.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const {
  evaluateModel,
  evaluateModelForReply,
  getEffectiveModelPolicy,
  resolveRuntimeModel,
  checkModelForSave,
  listPickableModels,
  replyModelFallback,
  listRejectedModels,
} = await import("./model-policy");
const { resolveAgent } = await import("./agent");

const DEFAULT = "anthropic/claude-haiku-4-5";
const SA = "sa1";
const cat = (...ids: string[]) =>
  ids.map((id) => ({ id, name: id, promptPerM: id === "pricey/model" ? 15 : 1, completionPerM: id === "pricey/model" ? 75 : 5 }));
const warn = vi.fn();

function seedCatalog(...ids: string[]) {
  mem.seed("appConfig/aiModels", { models: cat(...ids), fetchedAt: Date.now() });
}
function seedChannel(sa: string, channel: string, modelOverride: string | null, enabled = true) {
  mem.seed(`subAccounts/${sa}/aiAgent/${channel}`, { enabled, contextMessageCount: 10, modelOverride });
}
function seedPolicy(allowedModels: string[], maxPromptPerM: number | null = null) {
  mem.seed("agencies/ag1", { aiModelPolicy: { allowedModels, maxPromptPerM, maxCompletionPerM: null } });
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
  it("matches a :variant against its base id in the catalog", () => {
    expect(evaluateModel("a/one:nitro", { catalog, policy: { ...policy, allowedModels: ["a/one"] }, defaultModel: DEFAULT }))
      .toEqual({ ok: true });
  });
  it("judges only :nitro/:floor/:free as their base; :online and unknown suffixes need the full id ticked", () => {
    const allowOne = { ...policy, allowedModels: ["a/one"] };
    for (const v of ["a/one:nitro", "a/one:floor", "a/one:free"]) {
      expect(evaluateModel(v, { catalog, policy: allowOne, defaultModel: DEFAULT })).toEqual({ ok: true });
      expect(evaluateModelForReply(v, { catalog, savedPolicy: allowOne, defaultModel: DEFAULT })).toEqual({ ok: true });
    }
    for (const v of ["a/one:online", "a/one:thinking"]) {
      expect(evaluateModel(v, { catalog, policy: allowOne, defaultModel: DEFAULT })).toEqual({ ok: false, reason: "retired" });
      expect(evaluateModelForReply(v, { catalog, savedPolicy: allowOne, defaultModel: DEFAULT }))
        .toEqual({ ok: false, reason: "not_allowed" });
    }
    const ticked = { ...policy, allowedModels: ["a/one:online"] };
    // Exactly allow-listed: stands at save time too, though OpenRouter doesn't list it.
    expect(evaluateModel("a/one:online", { catalog, policy: ticked, defaultModel: DEFAULT })).toEqual({ ok: true });
    expect(evaluateModelForReply("a/one:online", { catalog, savedPolicy: ticked, defaultModel: DEFAULT })).toEqual({ ok: true });
  });
  it("reply-time: absence from the catalog never swaps; only the saved policy does", () => {
    const ctx = { catalog, defaultModel: DEFAULT };
    expect(evaluateModelForReply("gone/model", { ...ctx, savedPolicy: null })).toEqual({ ok: true });
    expect(evaluateModelForReply("gone/model", { ...ctx, savedPolicy: { ...policy, allowedModels: ["gone/model"] } }))
      .toEqual({ ok: true });
    expect(evaluateModelForReply("gone/model", { ...ctx, savedPolicy: policy })).toEqual({ ok: false, reason: "not_allowed" });
    expect(evaluateModelForReply("pricey/model:floor", { ...ctx, savedPolicy: policy })).toEqual({ ok: false, reason: "over_price" });
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
    mem.seed("subAccounts/sa2/aiConfig/main", { modelOverride: "legacy/model" });

    const { policy, saved } = await getEffectiveModelPolicy("ag1");
    expect(saved).toBe(false);
    expect([...policy.allowedModels].sort()).toEqual([DEFAULT, "a/one", "b/two", "legacy/model"].sort());
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

describe("reply-time resolution via resolveAgent", () => {
  it("keeps an allowed model, and a :variant of one", async () => {
    seedCatalog("a/one");
    seedPolicy(["a/one"]);
    seedChannel(SA, "sms", "a/one:nitro");
    expect((await resolveAgent(SA, "sms"))?.effective.modelOverride).toBe("a/one:nitro");
    expect(warn).not.toHaveBeenCalled();
  });

  it("KEEPS a stored model that is merely missing from the catalog (OpenRouter decides)", async () => {
    seedCatalog("a/one");
    seedChannel(SA, "sms", "gone/model");
    expect((await resolveAgent(SA, "sms"))?.effective.modelOverride).toBe("gone/model");
  });

  it("KEEPS a model the saved policy allows even though the catalog no longer lists it", async () => {
    seedCatalog("a/one");
    seedPolicy(["gone/model"]);
    seedChannel(SA, "sms", "gone/model");
    expect((await resolveAgent(SA, "sms"))?.effective.modelOverride).toBe("gone/model");
  });

  it("with no saved policy, doesn't even read or refresh the catalog", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("should not fetch"); });
    vi.stubGlobal("fetch", fetchSpy);
    expect(await resolveRuntimeModel(SA, "any/model")).toBe("any/model");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swaps a model the saved policy no longer allows for the app default, with a warning", async () => {
    seedCatalog("a/one", "b/two");
    seedChannel(SA, "web-chat", "b/two");
    seedPolicy(["a/one"]);
    expect((await resolveAgent(SA, "web-chat"))?.effective.modelOverride).toBe(DEFAULT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("b/two"));
  });

  it("swaps a model over the saved price ceiling", async () => {
    seedCatalog("pricey/model");
    seedPolicy(["pricey/model"], 10);
    seedChannel(SA, "sms", "pricey/model");
    expect((await resolveAgent(SA, "sms"))?.effective.modelOverride).toBe(DEFAULT);
  });

  it("skips resolution for a disabled channel", async () => {
    seedPolicy(["a/one"]);
    seedChannel(SA, "sms", "b/two", false);
    expect((await resolveAgent(SA, "sms"))?.effective.modelOverride).toBe("b/two");
  });

  it("never waits on OpenRouter, even with no catalog cached", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    seedPolicy(["a/one"]);
    expect(await resolveRuntimeModel(SA, "a/one")).toBe("a/one");
    expect(await resolveRuntimeModel(SA, "b/two")).toBe(DEFAULT);
  });

  it("honours AI_REPLIES_DEFAULT_MODEL as the fallback target; blank stays null", async () => {
    process.env.AI_REPLIES_DEFAULT_MODEL = "x/deploy-default";
    seedPolicy(["a/one"]);
    expect(await resolveRuntimeModel(SA, "b/two")).toBe("x/deploy-default");
    expect(await resolveRuntimeModel(SA, null)).toBeNull();
  });
});

describe("OpenRouter refused the model on a live reply", () => {
  it("flags the channel; the flag shows only while that model is still stored", async () => {
    seedChannel(SA, "sms", "gone/model");
    seedChannel(SA, "voice", "a/one");
    const { fallbackToDefault, onModelRejected } = replyModelFallback(SA, "sms");
    expect(fallbackToDefault).toBe(true);
    onModelRejected("gone/model");
    replyModelFallback(SA, "voice").onModelRejected("old/model");
    await vi.waitFor(async () => expect(await listRejectedModels(SA)).toEqual({ sms: "gone/model" }), { timeout: 10_000 });
  });
});
