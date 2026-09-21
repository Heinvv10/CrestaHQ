import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * When a web-chat visitor submits the capture form and becomes a contact,
 * that submission is the first turn on the contact's timeline. Driven
 * through the real capture POST; session persistence, reconciliation and
 * follow-ups are stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/ai/agent", () => ({
  getChannelConfig: async () => ({ enabled: true }),
}));
vi.mock("@/lib/comms/web-chat/rate-limit", () => ({ checkAndCount: () => ({ ok: true }) }));
vi.mock("@/lib/comms/web-chat/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/web-chat/session")>()),
  appendMessage: async () => "wm_1",
  markCaptureSkipped: async () => {},
}));
vi.mock("@/lib/comms/web-chat/capture", () => ({
  reconcileContactFromCapture: async () => ({ contactId: "c1", created: true }),
}));
vi.mock("@/lib/comms/web-chat/follow-up", () => ({
  createFollowUpActions: async () => ({ taskId: null, emailSent: false, errors: [] }),
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => {},
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { POST } = await import("./route");

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity" });
  mem.seed("subAccounts/sa1/webChatSessions/sess_0123456789abcdef", {
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: null,
  });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "" });
});

it("writes webchat_received on the reconciled contact for the submitted form", async () => {
  const res = await POST(
    new Request("https://app.test/api/web-chat/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sa: "sa1",
        sessionId: "sess_0123456789abcdef",
        name: "Naledi",
        email: "naledi@example.com",
      }),
    }),
  );
  expect(res.status).toBe(200);
  expect(mem.read("contacts/c1/activities/inbound_webchat_wm_1")).toMatchObject({
    type: "webchat_received",
    createdBy: "webchat_inbound",
    agencyId: "ag1",
    subAccountId: "sa1",
    content: "Web chat received: (submitted via form) name: Naledi, email: naledi@example.com",
    meta: { channel: "webchat", messageId: "wm_1" },
  });
});
