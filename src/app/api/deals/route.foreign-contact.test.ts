import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A member of sa1 must not link a deal to a contact that lives in another
 * sub-account: the contact id comes from the request body, and membership of
 * the ROUTE's sub-account says nothing about the contact it names. Refused
 * as 404 (not 403) so a foreign id reads the same as a missing one, and
 * nothing is written. Real routes + deals service over in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u_member", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[id]/route");

const json = (method: string, url: string, body: unknown) =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann" });
  mem.seed("contacts/cB", { subAccountId: "saB", agencyId: "ag1", name: "Foreign" });
});

it("POST /api/deals refuses a contact from another sub-account, writing nothing", async () => {
  const res = await POST(json("POST", "http://x/api/deals", {
    subAccountId: "sa1", title: "Fibre", contactId: "cB", stageId: "new",
  }));
  expect(res.status).toBe(404);
  expect(mem.list("deals")).toEqual([]);
  expect(mem.list("dealStageHistory")).toEqual([]);
});

it("POST /api/deals still accepts the sub-account's own contact", async () => {
  const res = await POST(json("POST", "http://x/api/deals", {
    subAccountId: "sa1", title: "Fibre", contactId: "c1", stageId: "new",
  }));
  expect(res.status).toBe(201);
  expect(mem.list("deals")).toHaveLength(1);
});

it("PATCH /api/deals/:id refuses re-pointing the deal at a foreign contact", async () => {
  mem.seed("deals/d1", {
    title: "D", value: 1, currency: "USD", contactId: "c1", stageId: "new",
    subAccountId: "sa1", agencyId: "ag1", mode: "live",
  });
  const patch = (body: unknown) =>
    PATCH(json("PATCH", "http://x/api/deals/d1", body), { params: Promise.resolve({ id: "d1" }) });

  const res = await patch({ contactId: "cB", title: "Renamed" });
  expect(res.status).toBe(404);
  expect(mem.read("deals/d1")).toMatchObject({ contactId: "c1", title: "D" });

  // The edit dialog echoes the stored contact id: that must keep working.
  expect((await patch({ contactId: "c1", title: "Renamed" })).status).toBe(200);
  expect(mem.read("deals/d1")).toMatchObject({ contactId: "c1", title: "Renamed" });
});
