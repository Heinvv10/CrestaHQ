import { beforeEach, expect, it, vi } from "vitest";

/**
 * PATCH /api/deals/[id] `completed`: the review request goes only when a Won
 * deal is FIRST marked completed (askReviewIfNewlyCompleted, shared with the
 * agent's mark_deal_completed).
 */
const fake = vi.hoisted(() => ({
  deal: { subAccountId: "sa", agencyId: "ag", stageId: "won", contactId: "c1", mode: "live" } as Record<string, unknown>,
  update: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => fake.deal }) }) }),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", subAccountId: "sa", subAccountRole: "admin" }),
}));
vi.mock("@/lib/server/deals-service", () => ({ updateDealServerSide: fake.update, deleteDealServerSide: vi.fn() }));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: fake.ask }));

import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(new Request("http://x/api/deals/d1", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "d1" }),
  });

beforeEach(() => {
  fake.deal.completed = undefined;
  fake.ask.mockClear();
  fake.update.mockReset().mockResolvedValue({ deal: { id: "d1", contact_id: "c1" }, stageTerminal: "won", previousCompleted: false });
});

it("a Won deal first marked completed asks for a review, once", async () => {
  expect((await patch({ completed: true })).status).toBe(200);
  expect(fake.ask).toHaveBeenCalledTimes(1);
  expect(fake.ask).toHaveBeenCalledWith({ subAccountId: "sa", agencyId: "ag", contactId: "c1", trigger: "deal_completed" });
});

it("an already completed deal (as the write's transaction saw it), or one not Won, or an unrelated edit asks for nothing", async () => {
  // Completed by someone else between the route's read and the write.
  fake.update.mockResolvedValueOnce({ deal: { id: "d1", contact_id: "c1" }, stageTerminal: "won", previousCompleted: true });
  await patch({ completed: true });
  fake.update.mockResolvedValue({ deal: { id: "d1", contact_id: "c1" }, stageTerminal: undefined, previousCompleted: false });
  await patch({ completed: true });
  await patch({ title: "Renamed" });
  expect(fake.ask).not.toHaveBeenCalled();
});
