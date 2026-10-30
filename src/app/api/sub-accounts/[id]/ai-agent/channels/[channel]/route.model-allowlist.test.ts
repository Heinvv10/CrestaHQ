import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Save-time model allow-list enforcement on the channel PATCH. Real tenancy
 * guard + agent config + policy over in-memory Firestore; the catalog is
 * seeded fresh so nothing is fetched.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem, claims } = await import("@/test/gbp-sync-store");
const { PATCH } = await import("./route");

const SA = "sa1";
const model = (m: string) => ({ id: m, name: m, promptPerM: 1, completionPerM: 5 });
function save(body: Record<string, unknown>) {
  return PATCH(
    new Request(`https://app.test/api/sub-accounts/${SA}/ai-agent/channels/sms`, {
      method: "PATCH",
      headers: { "x-user-uid": "admin", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA, channel: "sms" }) },
  );
}
const stored = () => mem.read(`subAccounts/${SA}/aiAgent/sms`)?.modelOverride ?? null;

beforeEach(() => {
  mem.clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  claims.set("admin", { status: "active", agencyId: "ag1" });
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "One" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/admin`, { uid: "admin", role: "admin", status: "active" });
  mem.seed("appConfig/aiModels", { models: ["a/one", "b/two"].map(model), fetchedAt: Date.now() });
  mem.seed("agencies/ag1", { aiModelPolicy: { allowedModels: ["a/one"], maxPromptPerM: null, maxCompletionPerM: null } });
});

describe("PATCH channel — modelOverride allow-list", () => {
  it("refuses a model the agency hasn't allowed, and stores nothing", async () => {
    const res = await save({ modelOverride: "b/two" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/allowed model list/);
    expect(stored()).toBeNull();
  });

  it("refuses a model OpenRouter no longer offers", async () => {
    const res = await save({ modelOverride: "gone/model" });
    expect(res.status).toBe(400);
    expect(stored()).toBeNull();
  });

  it("accepts an allowed model and a reset to default", async () => {
    expect((await save({ modelOverride: "a/one" })).status).toBe(200);
    expect(stored()).toBe("a/one");
    expect((await save({ modelOverride: null })).status).toBe(200);
    expect(stored()).toBeNull();
  });

  it("lets an existing config with a now-retired model keep saving its other settings", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/sms`, { enabled: false, contextMessageCount: 10, modelOverride: "gone/model" });
    const res = await save({ modelOverride: "gone/model", contextMessageCount: 20 });
    expect(res.status).toBe(200);
    expect(mem.read(`subAccounts/${SA}/aiAgent/sms`)).toMatchObject({ contextMessageCount: 20, modelOverride: "gone/model" });
  });
});
