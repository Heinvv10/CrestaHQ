import { beforeEach, expect, it, vi } from "vitest";

/**
 * PATCH /api/contacts/[id] assignee semantics. The edit form echoes the
 * stored `assignedToUid`; once that member is removed (row kept with
 * status "removed") every other edit of the contact must still go through.
 * Only a CHANGED assignee is validated against active membership.
 */
const fake = vi.hoisted(() => ({
  contact: {
    subAccountId: "sa",
    agencyId: "ag",
    assignedToUid: "gone" as string | null,
    mode: "live",
  },
  members: new Map<string, string>([["gone", "removed"], ["m1", "active"]]),
  update: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({}),
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => {
        if (path.startsWith("contacts/")) {
          return { exists: true, data: () => fake.contact };
        }
        const status = fake.members.get(path.split("/")[3]);
        return { exists: status !== undefined, data: () => ({ status }) };
      },
    }),
  }),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", subAccountId: "sa", subAccountRole: "admin" }),
}));
vi.mock("@/lib/server/contacts-service", () => ({
  updateContactServerSide: fake.update,
}));
vi.mock("@/lib/server/contact-delete", () => ({
  deleteContactServerSide: vi.fn(),
  findContactBlockers: vi.fn(),
}));
vi.mock("@/lib/custom-fields/load-defs", () => ({ loadCustomFieldDefs: async () => [] }));

import { PATCH } from "./route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://x/api/contacts/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "c1" }) },
  );
}

beforeEach(() => {
  fake.update.mockReset().mockResolvedValue({ id: "c1", contact: { id: "c1" } });
});

it("lets an edit through when the echoed assignee is a removed member", async () => {
  const res = await patch({ company: "Acme", assignedToUid: "gone" });
  expect(res.status).toBe(200);
  expect(fake.update).toHaveBeenCalledWith(
    expect.objectContaining({ patch: expect.objectContaining({ company: "Acme", assignedToUid: "gone" }) }),
  );
});

it("refuses a NEW assignee who is not an active member", async () => {
  const res = await patch({ company: "Acme", assignedToUid: "stranger" });
  expect(res.status).toBe(400);
  expect(fake.update).not.toHaveBeenCalled();
});

it("refuses reassigning to a member who was removed", async () => {
  fake.contact.assignedToUid = null;
  const res = await patch({ assignedToUid: "gone" });
  expect(res.status).toBe(400);
  fake.contact.assignedToUid = "gone";
});

it("accepts an active member and null", async () => {
  expect((await patch({ assignedToUid: "m1" })).status).toBe(200);
  expect((await patch({ assignedToUid: null })).status).toBe(200);
  expect(fake.update.mock.calls[1][0].patch.assignedToUid).toBeNull();
});
