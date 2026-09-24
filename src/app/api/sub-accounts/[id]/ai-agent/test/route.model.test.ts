import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The persona dry-run follows the live-reply model rules: a stored model the
 * agency's saved policy disallows runs on the app default; a model OpenRouter
 * refuses is retried once on the default and the channel is flagged.
 * In-memory Firestore; OpenRouter's HTTP API is a stubbed fetch.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const DEFAULT = "anthropic/claude-haiku-4-5";
/** Fake OpenRouter: models/list never answers (the reply path must not wait
 *  on it); chat refuses `gone/model` with a 404 and answers anything else. */
const chatModels: string[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/models")) return new Promise<Response>(() => undefined);
  const model = (JSON.parse(String(init?.body)) as { model: string }).model;
  chatModels.push(model);
  if (model === "gone/model") return new Response('{"error":{"message":"not a valid model ID"}}', { status: 404 });
  return Response.json({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 2 }, model });
});

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
  chatModels.length = 0;
  delete process.env.AI_REPLIES_DEFAULT_MODEL;
  process.env.OPENROUTER_API_KEY = "sk-test";
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  claims.set("admin", { status: "active", agencyId: "ag1" });
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "One" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/admin`, { uid: "admin", role: "admin", status: "active" });
  mem.seed(`subAccounts/${SA}/aiAgent/profile`, { systemPrompt: "Be nice", businessName: "One", escalationKeywords: [] });
  mem.seed("appConfig/aiModels", { models: [{ id: "a/one", name: "a", promptPerM: 1, completionPerM: 5 }], fetchedAt: Date.now() });
});

describe("ai-agent/test dry-run model", () => {
  it("retries a model OpenRouter refuses once on the app default, and flags the channel", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/sms`, { enabled: true, contextMessageCount: 10, modelOverride: "gone/model" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(chatModels).toEqual(["gone/model", DEFAULT]);
    await vi.waitFor(() =>
      expect(mem.read(`subAccounts/${SA}/aiAgent/sms`)?.modelRejected).toMatchObject({ model: "gone/model" }),
    );
  });

  it("runs a model the saved policy disallows on the default without asking OpenRouter for it", async () => {
    mem.seed("agencies/ag1", { aiModelPolicy: { allowedModels: [DEFAULT], maxPromptPerM: null, maxCompletionPerM: null } });
    mem.seed(`subAccounts/${SA}/aiAgent/sms`, { enabled: true, contextMessageCount: 10, modelOverride: "a/one" });
    await post();
    expect(chatModels).toEqual([DEFAULT]);
  });

  it("keeps an allowed stored model", async () => {
    mem.seed(`subAccounts/${SA}/aiAgent/sms`, { enabled: true, contextMessageCount: 10, modelOverride: "a/one" });
    await post();
    expect(chatModels).toEqual(["a/one"]);
  });
});
