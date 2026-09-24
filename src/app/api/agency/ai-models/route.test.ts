import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency AI model allow-list settings: agency-owner only, validated against
 * the cached OpenRouter catalog. In-memory Firestore; fetch stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem, claims } = await import("@/test/gbp-sync-store");
const { GET, PUT } = await import("./route");
const { resolveRuntimeModel, checkModelForSave, listPickableModels } = await import("@/lib/comms/ai/model-policy");

const DEFAULT = "anthropic/claude-haiku-4-5";
const model = (m: string) => ({ id: m, name: m, promptPerM: 1, completionPerM: 5 });
const req = (uid: string, body?: unknown) =>
  new Request("https://app.test/api/agency/ai-models", {
    method: body === undefined ? "GET" : "PUT",
    headers: { "x-user-uid": uid, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const policy = () => mem.read("agencies/ag1")?.aiModelPolicy as { allowedModels: string[] } | undefined;

beforeEach(() => {
  mem.clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  claims.set("admin", { status: "active", agencyId: "ag1" });
  mem.seed("agencies/ag1", { name: "Agency" });
  mem.seed("appConfig/aiModels", { models: ["a/one", "b/two", DEFAULT].map(model), fetchedAt: Date.now() });
});

describe("agency ai-models settings", () => {
  it("refuses a non-owner on read and write", async () => {
    expect((await GET(req("admin"))).status).toBe(403);
    expect((await PUT(req("admin", { allowedModels: ["b/two"] }))).status).toBe(403);
    expect(policy()).toBeUndefined();
  });

  it("owner sees the catalog and the unsaved in-use + default starting policy", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1" });
    mem.seed("subAccounts/sa1/aiAgent/sms", { modelOverride: "b/two" });
    const res = await GET(req("owner"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean; policy: { allowedModels: string[] }; catalog: unknown[] };
    expect(body.saved).toBe(false);
    expect(body.policy.allowedModels.sort()).toEqual([DEFAULT, "b/two"].sort());
    expect(body.catalog).toHaveLength(3);
  });

  it("owner saves ticks + ceiling; the default is always kept", async () => {
    const res = await PUT(req("owner", { allowedModels: ["a/one"], maxPromptPerM: 3, maxCompletionPerM: "" }));
    expect(res.status).toBe(200);
    expect(policy()).toEqual({ allowedModels: [DEFAULT, "a/one"], maxPromptPerM: 3, maxCompletionPerM: null });
  });

  it("an in-use id OpenRouter doesn't list (:online) survives the owner's first save and keeps replying", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1" });
    mem.seed("subAccounts/sa1/aiAgent/sms", { enabled: true, modelOverride: "a/one:online" });
    const shown = (await (await GET(req("owner"))).json()) as {
      policy: { allowedModels: string[]; maxPromptPerM: number | null; maxCompletionPerM: number | null };
      inUse: string[];
    };
    expect(shown.inUse).toEqual(["a/one:online"]);
    expect(shown.policy.allowedModels).toContain("a/one:online");

    // Save exactly what the page showed.
    const res = await PUT(req("owner", shown.policy));
    expect(res.status).toBe(200);
    expect(policy()?.allowedModels).toContain("a/one:online");
    expect(await resolveRuntimeModel("sa1", "a/one:online")).toBe("a/one:online");
    expect(await checkModelForSave("ag1", "a/one:online")).toBeNull();
    expect((await listPickableModels("ag1")).models.map((m) => m.id)).toContain("a/one:online");
  });

  it("rejects ids OpenRouter doesn't list and a negative ceiling", async () => {
    expect((await PUT(req("owner", { allowedModels: ["made/up"] }))).status).toBe(400);
    expect((await PUT(req("owner", { allowedModels: ["a/one"], maxPromptPerM: -1 }))).status).toBe(400);
    expect(policy()).toBeUndefined();
  });
});
