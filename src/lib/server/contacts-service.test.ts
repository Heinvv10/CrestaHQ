import { expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  txUpdate: vi.fn(),
  directUpdate: vi.fn(),
  mirror: vi.fn(),
}));
vi.mock("@/lib/server/conversation-mirror", () => ({
  mirrorContactAssignee: m.mirror,
}));
const data = {
  subAccountId: "sa",
  agencyId: "agency",
  territoryId: "global",
  mode: "live",
};
const ref = {
  path: "contacts/contact",
  get: async () => ({ exists: true, id: "contact", data: () => data }),
  update: m.directUpdate,
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ref,
    collection: () => {
      const q = { where: () => q };
      return q;
    },
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (r: unknown) =>
          r === ref
            ? { exists: true, data: () => data }
            : {
                docs: [
                  { ref: { path: "conversations/contact" }, data: () => data },
                ],
              },
        update: m.txUpdate,
      }),
  }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn() }));
vi.mock("@/lib/api/serializers/contacts", () => ({
  serializeContactForApi: () => ({ id: "contact" }),
}));
import { updateContactServerSide } from "./contacts-service";
it("public API territory patches move previews atomically with the contact", async () => {
  await updateContactServerSide({
    contactId: "contact",
    patch: { territoryId: "private" },
  });
  expect(m.directUpdate).not.toHaveBeenCalled();
  expect(m.txUpdate).toHaveBeenCalledWith(
    ref,
    expect.objectContaining({ territoryId: "private" })
  );
  expect(m.txUpdate).toHaveBeenCalledWith(
    { path: "conversations/contact" },
    expect.objectContaining({ territoryId: "private" })
  );
});

// SP2 T1 — this is the chokepoint for the dashboard PATCH and the public API
// PATCH; if it stops mirroring, both paths leave the inbox scope stale.
it("mirrors an owner change onto the contact's conversations", async () => {
  m.mirror.mockClear();
  await updateContactServerSide({
    contactId: "contact",
    patch: { assignedToUid: "m1" },
  });
  expect(m.mirror).toHaveBeenCalledWith({
    contactId: "contact",
    subAccountId: "sa",
    assigneeUid: "m1",
  });
  m.mirror.mockClear();
  await updateContactServerSide({
    contactId: "contact",
    patch: { assignedToUid: null },
  });
  expect(m.mirror).toHaveBeenCalledWith({
    contactId: "contact",
    subAccountId: "sa",
    assigneeUid: null,
  });
});
it("leaves the conversation owner alone when the patch has no owner key", async () => {
  m.mirror.mockClear();
  await updateContactServerSide({
    contactId: "contact",
    patch: { company: "Acme" },
  });
  expect(m.mirror).not.toHaveBeenCalled();
});
