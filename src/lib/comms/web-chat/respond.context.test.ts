import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Web chat is anonymous: the email a visitor types is only a claim. When
 * that claim matched an EXISTING contact, the bot must not be handed that
 * contact's deals / account data — otherwise anyone who knows a customer's
 * email can read their deals back through the chat bot. The context block
 * is only built for a contact this session itself created (every field on
 * it came from this visitor). Real `respondToWebChat`; the session store,
 * agent, prompt builder and LLM are stubbed.
 */

const mem = createMemoryFirestore();
let session: Record<string, unknown> = {};
const buildContext = vi.fn(async () => "Active deals:\n  - \"Fibre 100Mbps install\"");
const promptArgs: Array<{ contactContextBlock: string | null }> = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/web-chat/session", () => ({
  getOrCreateSession: async () => session,
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
      contextMessageCount: 10, modelOverride: null,
    },
  }),
  incrementChannelTokens: async () => {},
}));
vi.mock("@/lib/comms/business-hours", () => ({ isWithinBusinessHours: () => true }));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => ({ allowed: true }) }));
vi.mock("@/lib/comms/ai/context", () => ({ buildContactContextBlock: buildContext }));
vi.mock("@/lib/comms/ai/prompt", () => ({
  buildSystemPrompt: (args: { contactContextBlock: string | null }) => {
    promptArgs.push(args);
    return "SYSTEM";
  },
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({
  callAi: async () => ({ text: "Hi!", totalTokens: 5, model: "m" }),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => {},
  getConversationControls: async () => ({ botMode: "auto", botPausedUntilMs: null }),
  setConversationDraft: async () => {},
}));

const { respondToWebChat } = await import("./respond");

const input = {
  subAccountId: "sa1", agencyId: "ag1", sessionId: "sess_1",
  incomingMessage: "What's the status of my order?", pageUrl: null, referrer: null,
  origin: null, visitorIp: null, visitorUserAgent: null,
};

beforeEach(() => {
  mem.clear();
  promptArgs.length = 0;
  buildContext.mockClear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity" });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", name: "Naledi", email: "naledi@example.com",
  });
});

it("a session linked to an EXISTING contact by claimed email gets no contact context", async () => {
  session = { id: "sess_1", contactId: "c1", contactCreatedBySession: false, capturedPhone: null, pageUrl: null };
  const { outcome } = await respondToWebChat(input as Parameters<typeof respondToWebChat>[0]);
  expect(outcome.kind).toBe("replied");
  expect(promptArgs).toHaveLength(1);
  expect(promptArgs[0].contactContextBlock).toBeNull();
  expect(buildContext).not.toHaveBeenCalled();
});

it("a legacy linked session (no flag) also gets no contact context", async () => {
  session = { id: "sess_1", contactId: "c1", capturedPhone: null, pageUrl: null };
  await respondToWebChat(input as Parameters<typeof respondToWebChat>[0]);
  expect(promptArgs[0].contactContextBlock).toBeNull();
});

it("a contact this session created from the visitor's own details keeps its context", async () => {
  session = { id: "sess_1", contactId: "c1", contactCreatedBySession: true, capturedPhone: null, pageUrl: null };
  await respondToWebChat(input as Parameters<typeof respondToWebChat>[0]);
  expect(buildContext).toHaveBeenCalledTimes(1);
  expect(promptArgs[0].contactContextBlock).toContain("Fibre 100Mbps install");
});
