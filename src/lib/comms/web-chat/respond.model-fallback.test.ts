import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Web chat live-reply seam: when OpenRouter refuses the channel's model
 * override, the reply retries once on the app default and the web-chat
 * channel doc is flagged `modelRejected`. Real `respondToWebChat` + REAL
 * OpenRouter client over a stubbed fetch; session/agent/prompt are stubbed.
 */

const mem = createMemoryFirestore();

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/web-chat/session", () => ({
  getOrCreateSession: async () => ({ id: "sess_1", contactId: null, capturedPhone: null, pageUrl: null }),
  appendMessage: async () => "wm_1",
  loadRecentHistory: async () => [],
  markCapturePromptShown: async () => {},
}));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => ({
    effective: {
      enabled: true, systemPrompt: "Be helpful.", businessName: "Velocity",
      hoursStart: null, hoursEnd: null, timezone: "Africa/Johannesburg",
      escalationKeywords: [], escalationNotifyEmail: null,
      contextMessageCount: 10, modelOverride: "gone/model",
    },
  }),
  incrementChannelTokens: async () => {},
}));
vi.mock("@/lib/comms/business-hours", () => ({ isWithinBusinessHours: () => true }));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/comms/ai/context", () => ({ buildContactContextBlock: async () => null }));
vi.mock("@/lib/comms/ai/prompt", () => ({ buildSystemPrompt: () => "SYSTEM" }));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => {},
  getConversationControls: async () => ({ botMode: "auto", botPausedUntilMs: null }),
  setConversationDraft: async () => {},
}));

const { respondToWebChat } = await import("./respond");

const DEFAULT = "anthropic/claude-haiku-4-5";
const models: string[] = [];
const input = {
  subAccountId: "sa1", agencyId: "ag1", sessionId: "sess_1",
  incomingMessage: "Hi", pageUrl: null, referrer: null,
  origin: null, visitorIp: null, visitorUserAgent: null,
};

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
    return Response.json({ choices: [{ message: { content: "Hello!" } }], usage: { total_tokens: 3 }, model });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retries a refused override once on the app default, replies, and flags the web-chat channel", async () => {
  const { outcome } = await respondToWebChat(input as Parameters<typeof respondToWebChat>[0]);
  expect(outcome.kind).toBe("replied");
  expect(models).toEqual(["gone/model", DEFAULT]);
  await vi.waitFor(() =>
    expect(mem.read("subAccounts/sa1/aiAgent/web-chat")?.modelRejected).toMatchObject({ model: "gone/model" }),
    { timeout: 10_000 },
  );
});
