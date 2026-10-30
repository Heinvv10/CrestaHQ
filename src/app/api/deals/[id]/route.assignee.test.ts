import { beforeEach, expect, it, vi } from "vitest";

/**
 * PATCH /api/deals/[id] assignee semantics — same contract as the contact
 * route: an echoed, unchanged assignee is never re-validated (a removed
 * member must not lock the deal's other fields), a changed one must be an
 * active member.
 */
const fake = vi.hoisted(() => ({
  deal: {
    subAccountId: "sa",
    agencyId: "ag",
    assignedToUid: "gone" as string | null,
    stageId: "new",
    mode: "live",
  },
  members: new Map<string, string>([["gone", "removed"], ["m1", "active"]]),
  update: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => {
        if (path.startsWith("deals/")) return { exists: true, data: () => fake.deal };
        const status = fake.members.get(path.split("/")[3]);
        return { exists: status !== undefined, data: () => ({ status }) };
      },
    }),
  }),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", subAccountId: "sa", subAccountRole: "admin" }),
}));
vi.mock("@/lib/server/deals-service", () => ({
  updateDealServerSide: fake.update,
  deleteDealServerSide: vi.fn(),
}));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn() }));
vi.mock("@/lib/custom-fields/load-defs", () => ({ loadCustomFieldDefs: async () => [] }));

import { PATCH } from "./route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://x/api/deals/d1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "d1" }) },
  );
}

beforeEach(() => {
  fake.update.mockReset().mockResolvedValue({ deal: { id: "d1" } });
});

it("lets an edit through when the echoed assignee is a removed member", async () => {
  const res = await patch({ title: "Renamed", assignedToUid: "gone" });
  expect(res.status).toBe(200);
  expect(fake.update.mock.calls[0][0].patch).toMatchObject({ title: "Renamed", assignedToUid: "gone" });
});

it("refuses a NEW assignee who is not an active member", async () => {
  expect((await patch({ title: "Renamed", assignedToUid: "stranger" })).status).toBe(400);
  fake.deal.assignedToUid = null;
  expect((await patch({ assignedToUid: "gone" })).status).toBe(400);
  fake.deal.assignedToUid = "gone";
  expect(fake.update).not.toHaveBeenCalled();
});

it("accepts an active member and null", async () => {
  expect((await patch({ assignedToUid: "m1" })).status).toBe(200);
  expect((await patch({ assignedToUid: null })).status).toBe(200);
  expect(fake.update.mock.calls[1][0].patch.assignedToUid).toBeNull();
});
