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
const limitedIps: string[] = [];
vi.mock("@/lib/comms/web-chat/rate-limit", () => ({
  checkAndCount: (ip: string) => {
    limitedIps.push(ip);
    return { ok: true };
  },
}));
// The one trusted client-IP helper; the route must key its limit on it, not
// on the left-most X-Forwarded-For entry the caller controls.
vi.mock("@/lib/checkout/rate-limit", () => ({ clientIpFrom: () => "trusted-ip" }));
vi.mock("@/lib/comms/web-chat/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/web-chat/session")>()),
  appendMessage: async () => "wm_1",
  markCaptureSkipped: async () => {},
}));
let reconcileCreated = true;
vi.mock("@/lib/comms/web-chat/capture", () => ({
  reconcileContactFromCapture: async () => ({ contactId: "c1", created: reconcileCreated }),
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
  reconcileCreated = true;
  limitedIps.length = 0;
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

function submit() {
  return POST(
    new Request("https://app.test/api/web-chat/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({
        sa: "sa1",
        sessionId: "sess_0123456789abcdef",
        email: "naledi@example.com",
      }),
    }),
  );
}

it("flags a match to a pre-existing contact as unverified on the timeline", async () => {
  reconcileCreated = false;
  expect((await submit()).status).toBe(200);
  const row = mem.read("contacts/c1/activities/inbound_webchat_wm_1") as { content: string };
  expect(row.content).toContain("unverified");
});

it("does not flag a contact the submission itself created", async () => {
  expect((await submit()).status).toBe(200);
  const row = mem.read("contacts/c1/activities/inbound_webchat_wm_1") as { content: string };
  expect(row.content).not.toContain("unverified");
});

it("rate-limits on the trusted client IP, not the caller-supplied X-Forwarded-For", async () => {
  await submit();
  expect(limitedIps).toEqual(["trusted-ip"]);
});
