import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Vapi custom-LLM live-reply seam: when OpenRouter refuses the voice
 * channel's model override, the turn retries once on the app default (the
 * caller still hears a reply) and the voice channel doc is flagged
 * `modelRejected`. Real route + REAL OpenRouter client over a stubbed fetch;
 * webhook auth, agent resolution, prompt and booking are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/voice/webhook-auth", () => ({ vapiWebhookAuthorized: () => true }));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => ({
    channel: { voice: {} },
    effective: {
      enabled: true, systemPrompt: "Be helpful.", businessName: "Velocity",
      hoursStart: null, hoursEnd: null, timezone: "Africa/Johannesburg",
      escalationKeywords: [], escalationNotifyEmail: null,
      contextMessageCount: 10, modelOverride: "gone/model",
    },
  }),
  incrementChannelTokens: async () => {},
}));
vi.mock("@/lib/comms/ai/context", () => ({ buildContactContextBlock: async () => null }));
vi.mock("@/lib/comms/ai/prompt", () => ({ buildSystemPrompt: () => "SYSTEM" }));
vi.mock("@/lib/server/agent-booking-service", () => ({
  bookAgentSlot: vi.fn(), formatSlotForSpeech: vi.fn(), getAgentBookingContext: vi.fn(), listAgentSlots: vi.fn(),
}));

const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const DEFAULT = "anthropic/claude-haiku-4-5";
const models: string[] = [];

beforeEach(() => {
  mem.clear();
  models.length = 0;
  process.env.OPENROUTER_API_KEY = "sk-test";
  delete process.env.AI_REPLIES_DEFAULT_MODEL;
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const model = (JSON.parse(String(init?.body)) as { model: string }).model;
    models.push(model);
    if (model === "gone/model") return new Response('{"error":{"message":"not found"}}', { status: 404 });
    return Response.json({ choices: [{ message: { content: "Hello caller" } }], usage: { total_tokens: 3 }, model });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retries a refused override once on the app default, speaks the reply, and flags the voice channel", async () => {
  const res = await POST(
    new Request("https://app.test/api/webhooks/vapi/llm/sa1?s=x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "hi" }] }),
    }),
    { params: Promise.resolve({ subAccountId: "sa1" }) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0]!.message.content).toBe("Hello caller");
  expect(models).toEqual(["gone/model", DEFAULT]);
  await vi.waitFor(() =>
    expect(mem.read("subAccounts/sa1/aiAgent/voice")?.modelRejected).toMatchObject({ model: "gone/model" }),
    { timeout: 10_000 },
  );
});
