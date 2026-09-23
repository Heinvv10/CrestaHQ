import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Scheduled messages authorise through requireContactAccessible, so a scoped
 * collaborator can neither list, book nor cancel a scheduled message for an
 * out-of-territory contact. Real route-auth + territory-filter; the
 * scheduling service is a spy.
 */

const mem = createMemoryFirestore();
const t = vi.hoisted(() => ({
  list: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1", agencyRole: "staff" } }),
  }),
}));
vi.mock("@/lib/server/scheduled-messages/service", () => ({
  listScheduledMessages: t.list,
  scheduleConversationMessage: t.schedule,
  cancelScheduledMessage: t.cancel,
}));
vi.mock("@/lib/server/scheduled-messages/parse", () => ({
  parseScheduleRequest: (raw: { contactId: string }) => ({ ok: true, value: raw }),
}));

const { GET, POST } = await import("./route");
const { DELETE } = await import("./[msgId]/route");

const H = { "x-user-uid": "u1", "content-type": "application/json" };
const ctx = { params: Promise.resolve({ id: "sa1" }) };
const list = (c: string) =>
  GET(new Request(`http://x/api?contactId=${c}`, { headers: H }), ctx);
const book = (c: string) =>
  POST(new Request("http://x/api", { method: "POST", headers: H, body: JSON.stringify({ contactId: c }) }), ctx);
const cancel = (c: string) =>
  DELETE(new Request(`http://x/api?contactId=${c}`, { method: "DELETE", headers: H }), {
    params: Promise.resolve({ id: "sa1", msgId: "m1" }),
  });

beforeEach(() => {
  mem.clear();
  t.list.mockReset().mockResolvedValue([]);
  t.schedule.mockReset().mockResolvedValue({ ok: true, id: "m1" });
  t.cancel.mockReset().mockResolvedValue({ ok: true, action: "cancelled" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", {
    status: "active",
    role: "collaborator",
    assignedTerritoryIds: ["t1"],
  });
  mem.seed("contacts/in", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t1" });
  mem.seed("contacts/out", { agencyId: "ag1", subAccountId: "sa1", territoryId: "t2" });
});

it("refuses a scoped collaborator every action on an out-of-territory contact", async () => {
  expect((await list("out")).status).toBe(403);
  expect((await book("out")).status).toBe(403);
  expect((await cancel("out")).status).toBe(403);
  expect(t.list).not.toHaveBeenCalled();
  expect(t.schedule).not.toHaveBeenCalled();
  expect(t.cancel).not.toHaveBeenCalled();
});

it("allows every action on an in-territory contact", async () => {
  expect((await list("in")).status).toBe(200);
  expect((await book("in")).status).toBe(200);
  expect((await cancel("in")).status).toBe(200);
});
