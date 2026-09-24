import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The persona dry-run uses the same request-time model check as live replies:
 * a retired stored model runs on the app default instead of failing.
 * In-memory Firestore; only the OpenRouter chat call is faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const callAi = vi.fn(async ({ model }: { model?: string }) => ({
  text: "hi", promptTokens: 1, completionTokens: 1, totalTokens: 2, model: model ?? "default",
}));
vi.mock("@/lib/comms/ai/openrouter", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/ai/openrouter")>()),
  aiIsConfigured: () => true,
  callAi,
}));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const SA = "sa1";
const post = () =>
  POST(
    new Request(`https://app.test/api/sub-accounts/${SA}/ai-agent/test`, {
      method: "POST",
      headers: { "x-user-uid": "admin", "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    }),
    { params: Promise.resolve({ id: SA }) },
  );

beforeEach(() => {
  mem.clear();
  callAi.mockClear();
  delete process.env.AI_REPLIES_DEFAULT_MODEL;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  claims.set("admin", { status: "active", agencyId: "ag1" });
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "One" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/admin`, { uid: "admin", role: "admin", status: "active" });
  mem.seed(`subAccounts/${SA}/aiAgent/profile`, { systemPrompt: "Be nice", businessName: "One", escalationKeywords: [] });
  mem.seed("appConfig/aiModels", { models: [{ id: "a/one", name: "a", promptPerM: 1, completionPerM: 5 }], fetchedAt: Date.now() });
});

describe("ai-agent/test dry-run model", () => {
  it("runs a retired stored model on the app default", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/sms`, { enabled: true, contextMessageCount: 10, modelOverride: "gone/model" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(callAi).toHaveBeenCalledWith(expect.objectContaining({ model: "anthropic/claude-haiku-4-5" }));
  });

  it("keeps a listed stored model", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/sms`, { enabled: true, contextMessageCount: 10, modelOverride: "a/one" });
    await post();
    expect(callAi).toHaveBeenCalledWith(expect.objectContaining({ model: "a/one" }));
  });
});
