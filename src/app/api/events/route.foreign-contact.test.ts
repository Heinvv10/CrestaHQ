import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * POST /api/events must not attach a calendar event to a contact from
 * another sub-account. Foreign id ⇒ 404, nothing written. Real route +
 * events service, in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u_member", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { POST } = await import("./route");

const post = (contactId: string) =>
  POST(new Request("http://x/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subAccountId: "sa1", title: "Site visit", contactId,
      startAt: "2026-10-01T09:00:00Z", endAt: "2026-10-01T10:00:00Z",
    }),
  }));

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  mem.seed("contacts/cB", { subAccountId: "saB", agencyId: "ag1", name: "Foreign" });
});

it("refuses a contact from another sub-account with 404 and writes nothing", async () => {
  expect((await post("cB")).status).toBe(404);
  expect(mem.list("events")).toEqual([]);
});

it("accepts the sub-account's own contact", async () => {
  expect((await post("c1")).status).toBe(201);
  expect(mem.list("events")).toEqual([expect.objectContaining({ contactId: "c1" })]);
});
