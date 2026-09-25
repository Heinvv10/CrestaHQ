import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * update_deal and delete_deal (PR9) through the real dispatch, decide route
 * and deals-service: an edit never completes a deal (so no review request),
 * a delete waits for a person, and both stay inside the sub-account.
 */

const reviewAsk = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock("@/lib/reviews/request", async (orig) => ({ ...((await orig()) as object), maybeSendReviewRequest: reviewAsk }));
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...((await orig()) as object), qstashIsConfigured: () => true, publishCallback: async () => ({ messageId: "q1" }),
}));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const DEAL = {
  subAccountId: "sa1", agencyId: "ag1", mode: "live", title: "Fibre 100", value: 500, currency: "ZAR", priority: "medium",
  stageId: "won", contactId: "c1", territoryId: "global",
};
const deal = () => mem.read("deals/d1");
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);

beforeEach(() => {
  reviewAsk.mockClear();
  mem.seed("deals/d1", DEAL);
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", territoryId: "global" });
});

describe("update_deal", () => {
  it("edits title, value, currency and priority, stamped as the agent's", async () => {
    expect(await call("update_deal", { dealId: "d1", title: "Fibre 200", value: 700, currency: "usd", priority: "high" }))
      .toMatchObject({ ok: true, resultText: "Updated the deal." });
    expect(deal()).toMatchObject({ title: "Fibre 200", value: 700, currency: "USD", priority: "high", stageId: "won", lastAgentEditKey: "abcd1234" });
  });

  it("`completed: true` on a Won deal is dropped: the deal isn't completed and no review request is sent", async () => {
    expect(await call("update_deal", { dealId: "d1", title: "Fibre 200", completed: true })).toMatchObject({ ok: true });
    expect(deal()!.completed).toBeUndefined();
    expect(reviewAsk).not.toHaveBeenCalled();
    expect(await call("update_deal", { dealId: "d1", completed: true })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it.each([
    ["an empty title", { title: " " }],
    ["an invisible character in the title", { title: "Fibre\u200b" }],
    ["a negative value", { value: -1 }],
    ["a value as text", { value: "700" }],
    ["a 4-letter currency", { currency: "RAND" }],
    ["an unknown priority", { priority: "urgent" }],
    ["a stage (use move_deal_stage)", { stageId: "lost" }],
  ])("%s → refused, nothing written", async (_label, patch) => {
    expect(await call("update_deal", { dealId: "d1", ...patch })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(deal()).toEqual(DEAL);
  });
});

it("create_deal by an agent is stamped as the agent's", async () => {
  const r = await call("create_deal", { title: "New", value: 1, contactId: "c1", contactName: "Ann" });
  expect(r).toMatchObject({ ok: true, ref: { kind: "deal" } });
  expect(mem.read(`deals/${(r as { ref: { id: string } }).ref.id}`)).toMatchObject({ title: "New", lastAgentEditKey: "abcd1234" });
});

describe("delete_deal", () => {
  it("→ a proposal, nothing deleted, the preview warns after an agent edit; approve deletes", async () => {
    await call("update_deal", { dealId: "d1", title: "Old deal" });
    const r = await call("delete_deal", { dealId: "d1" });
    if (!("proposal" in r)) throw new Error(JSON.stringify(r));
    const id = r.proposal.id;
    expect(row(id)).toMatchObject({ approval: "hard_delete", territoryId: "global", targetScoped: true });
    expect(row(id).preview).toContainEqual({ label: "Delete deal", value: "Old deal" });
    expect(row(id).preview).toContainEqual({ label: "Warning", value: expect.stringContaining("Last edited by API agent abcd1234") });
    expect(deal()).toBeDefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(deal()).toBeUndefined();
  });
});

describe("tenancy", () => {
  it.each(["update_deal", "delete_deal"])("%s with an id that is a path → refused as invalid args", async (name) => {
    expect(await call(name, { dealId: "d1/sub/y", title: "X" })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it.each([
    ["update_deal", { title: "X" }],
    ["delete_deal", {}],
  ])("%s on another sub-account's deal → refused, nothing written", async (name, args) => {
    mem.seed("deals/d2", { ...DEAL, subAccountId: "sa2" });
    const before = JSON.stringify(mem.all());
    expect(await call(name, { dealId: "d2", ...args })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
  });
});
