import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Operator web-chat send refuses a scoped collaborator a session captured to
 * an out-of-territory contact. Real territory-filter; in-memory Firestore.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({ role: "collaborator" as string, append: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_r: Request, subAccountId: string) => ({
    uid: "u1",
    subAccountId,
    subAccountRole: t.role,
  }),
}));
vi.mock("@/lib/comms/web-chat/session", () => ({
  appendMessage: t.append,
  isValidSessionId: (s: unknown) => typeof s === "string" && s.length > 0,
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async () => undefined,
}));
vi.mock("@/lib/comms/web-chat/respond", () => ({ webChatVisitorLabel: () => "Visitor" }));

const { POST } = await import("./route");
const send = (sessionId: string) =>
  POST(
    new Request("http://x/api/comms/web-chat/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subAccountId: "sa1", sessionId, body: "hello" }),
    }),
  );

function seedSession(id: string, contactId: string | null) {
  mem.seed(`subAccounts/sa1/webChatSessions/${id}`, {
    agencyId: "ag1",
    contactId,
    capturedName: null,
    capturedPhone: null,
    pageUrl: null,
    referrer: null,
  });
}

beforeEach(() => {
  mem.clear();
  t.role = "collaborator";
  t.append.mockReset().mockResolvedValue("m1");
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  mem.seed("contacts/cIn", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("contacts/cOut", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
  seedSession("sIn", "cIn");
  seedSession("sOut", "cOut");
  seedSession("sAnon", null);
});

it("refuses a scoped collaborator a session linked to an out-of-territory contact", async () => {
  expect((await send("sOut")).status).toBe(403);
  expect(t.append).not.toHaveBeenCalled();
});

it("allows an in-territory session and an anonymous one", async () => {
  expect((await send("sIn")).status).toBe(200);
  expect((await send("sAnon")).status).toBe(200);
});

it("does not scope an admin", async () => {
  t.role = "admin";
  expect((await send("sOut")).status).toBe(200);
});
