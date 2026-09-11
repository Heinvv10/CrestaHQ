import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A web-chat message on a session already attributed to a contact is a
 * customer message on that contact's timeline. Real `respondToWebChat`;
 * the session store and the AI are stubbed (no agent ⇒ holding reply).
 */

const mem = createMemoryFirestore();
let sessionContactId: string | null = "c1";
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/web-chat/session", () => ({
  getOrCreateSession: async () => ({
    id: "sess_1", contactId: sessionContactId, capturedPhone: null, pageUrl: null,
  }),
  appendMessage: async () => "wm_9",
  loadRecentHistory: async () => [],
  markCapturePromptShown: async () => {},
}));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => null,
  incrementChannelTokens: async () => {},
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => {},
  getConversationControls: async () => ({ botMode: "auto", botPausedUntil: null }),
  setConversationDraft: async () => {},
}));

const { respondToWebChat } = await import("./respond");

const input = {
  subAccountId: "sa1", agencyId: "ag1", sessionId: "sess_1",
  incomingMessage: "Do you cover Centurion?", pageUrl: null, referrer: null,
  origin: null, visitorIp: null, visitorUserAgent: null,
};

beforeEach(() => {
  mem.clear();
  sessionContactId = "c1";
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Naledi" });
});

it("writes webchat_received on the session's contact, keyed by the message id", async () => {
  await respondToWebChat(input as Parameters<typeof respondToWebChat>[0]);
  expect(mem.read("contacts/c1/activities/inbound_webchat_wm_9")).toMatchObject({
    type: "webchat_received",
    createdBy: "webchat_inbound",
    agencyId: "ag1",
    subAccountId: "sa1",
    content: "Web chat received: Do you cover Centurion?",
    meta: { channel: "webchat", messageId: "wm_9" },
  });
});

it("writes nothing for an anonymous session", async () => {
  sessionContactId = null;
  await respondToWebChat(input as Parameters<typeof respondToWebChat>[0]);
  expect(mem.list("contacts/c1/activities")).toEqual([]);
});
