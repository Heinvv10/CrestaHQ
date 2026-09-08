import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ txWrites: vi.fn(), batchWrites: vi.fn() }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "admin" }),
}));
const contact = {
  subAccountId: "sa",
  agencyId: "agency",
  territoryId: "global",
};
const doc = (path: string) => ({
  path,
  get: async () => ({
    exists: true,
    data: () =>
      path.startsWith("contacts/")
        ? contact
        : { status: "active", name: "North" },
  }),
  collection: () => ({ add: async () => {} }),
});
const collection = (path: string) => {
  const q = { path, where: () => q, get: async () => ({ size: 0, docs: [] }) };
  return q;
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc,
    collection,
    batch: () => ({ update: m.batchWrites, commit: async () => {} }),
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (ref: { path: string }) =>
          ref.path === "conversations"
            ? {
                docs: [
                  {
                    ref: doc("conversations/contact"),
                    data: () => ({ ...contact, contactId: "contact" }),
                  },
                ],
              }
            : { exists: true, data: () => contact },
        update: m.txWrites,
      }),
  }),
}));
import { PATCH } from "./route";
beforeEach(() => vi.clearAllMocks());
it("moves contact and conversation territory atomically", async () => {
  const res = await PATCH(
    new Request("https://crm.test", {
      method: "PATCH",
      body: JSON.stringify({ territoryId: "north" }),
    }),
    { params: Promise.resolve({ id: "sa", contactId: "contact" }) }
  );
  expect(res.status).toBe(200);
  expect(m.txWrites).toHaveBeenCalledWith(
    expect.objectContaining({ path: "contacts/contact" }),
    expect.objectContaining({ territoryId: "north" })
  );
  expect(m.txWrites).toHaveBeenCalledWith(
    expect.objectContaining({ path: "conversations/contact" }),
    expect.objectContaining({ territoryId: "north" })
  );
  expect(m.batchWrites).not.toHaveBeenCalledWith(
    expect.objectContaining({ path: "contacts/contact" }),
    expect.anything()
  );
});
