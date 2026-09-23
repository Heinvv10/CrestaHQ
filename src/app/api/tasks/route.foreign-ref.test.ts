import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * POST /api/tasks links a contact, deal and event by ids from the body. Each
 * must live in the route's sub-account: a foreign id is a 404 and nothing is
 * written — not the task, and not the activity row the service would drop
 * on the other tenant's contact. Real route + tasks service, in-memory
 * Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u_member", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { POST } = await import("./route");

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://x/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subAccountId: "sa1", title: "Call back", ...body }),
  }));

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  mem.seed("contacts/cB", { subAccountId: "saB", agencyId: "ag1", name: "Foreign" });
  mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1" });
  mem.seed("deals/dB", { subAccountId: "saB", agencyId: "ag1", contactId: "cB" });
  mem.seed("events/e1", { subAccountId: "sa1", agencyId: "ag1" });
  mem.seed("events/eB", { subAccountId: "saB", agencyId: "ag1" });
});

it.each([
  ["contactId", { contactId: "cB" }],
  ["dealId", { dealId: "dB" }],
  ["eventId", { eventId: "eB" }],
])("refuses a foreign %s with 404 and writes nothing", async (_label, ref) => {
  const res = await post(ref);
  expect(res.status).toBe(404);
  expect(mem.list("tasks")).toEqual([]);
  expect(mem.list("contacts/cB/activities")).toEqual([]);
});

it("accepts the sub-account's own contact, deal and event", async () => {
  const res = await post({ contactId: "c1", dealId: "d1", eventId: "e1" });
  expect(res.status).toBe(201);
  expect(mem.list("tasks")).toEqual([
    expect.objectContaining({ contactId: "c1", dealId: "d1", eventId: "e1" }),
  ]);
});
