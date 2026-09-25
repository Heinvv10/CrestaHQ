import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * mark_deal_completed (PR9b) through the real dispatch, decide route and
 * deals-service: proposing sends nothing; the approver sees who a review
 * request would go to; approve completes the deal and asks for the review
 * exactly once, through the deal card's own path.
 */

const reviewAsk = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ sent: true })));
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
  subAccountId: "sa1", agencyId: "ag1", mode: "live", title: "Fibre 100", value: 500, currency: "ZAR",
  stageId: "won", contactId: "c1", territoryId: "global",
};
const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann Smith", phone: "+27821111111", territoryId: "global" };
const REVIEWS = { enabled: true, triggerOnDealCompleted: true, reviewUrl: "https://g.page/r/fixture/review", channel: "sms" };
const call = (args: Record<string, unknown> = {}) => dispatchAgentTool(auth, "mark_deal_completed", { dealId: "d1", ...args });
async function proposeId(): Promise<string> {
  const r = await call();
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const reviewRow = (id: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === "Review request")!.value;

beforeEach(() => {
  reviewAsk.mockClear();
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleReviewConfig: REVIEWS });
  mem.seed("deals/d1", DEAL);
  mem.seed("contacts/c1", ANN);
});

describe("mark_deal_completed", () => {
  it("proposing sends nothing and names the review request's recipient; approve completes and asks exactly once", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(reviewRow(id)).toBe("Sent to Ann Smith (…1111) by SMS, unless quiet hours, an opt-out or the review cooldown stop it.");
    expect(row(id).pinned).toEqual({ dealId: "d1", contactId: "c1", phone: "+27821111111" });
    expect(reviewAsk).not.toHaveBeenCalled();
    expect(mem.read("deals/d1")!.completed).toBeUndefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("deals/d1")!.completed).toBe(true);
    expect(reviewAsk).toHaveBeenCalledTimes(1);
    expect(reviewAsk).toHaveBeenCalledWith({ subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "deal_completed" });
  });

  it.each([
    ["review requests off", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleReviewConfig: { ...REVIEWS, triggerOnDealCompleted: false } }), "None: review requests for completed deals are off in this workspace."],
    ["no review link", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleReviewConfig: { ...REVIEWS, reviewUrl: "" } }), "None: review requests for completed deals are off in this workspace."],
    ["a contact with no phone", () => mem.seed("contacts/c1", { ...ANN, phone: "" }), "None: the deal's contact has no phone number."],
    ["the WhatsApp channel", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleReviewConfig: { ...REVIEWS, channel: "whatsapp_template" } }), "Sent to Ann Smith (…1111) by WhatsApp, unless quiet hours, an opt-out or the review cooldown stop it."],
  ])("%s → the preview says so", async (_label, arrange, text) => {
    arrange();
    expect(reviewRow(await proposeId())).toBe(text);
  });

  it.each([
    ["a deal not on a Won stage", () => mem.seed("deals/d1", { ...DEAL, stageId: "new" }), "Only a Won deal can be marked completed."],
    ["an already completed deal", () => mem.seed("deals/d1", { ...DEAL, completed: true }), "That deal is already completed."],
    ["another sub-account's deal", () => mem.seed("deals/d1", { ...DEAL, subAccountId: "sa2" }), "That deal wasn't found in this workspace."],
  ])("%s → refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call()).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("an id that is a path → invalid args", async () => {
    expect(await call({ dealId: "d1/sub/y" })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("the contact's number changed since the proposal → preview_changed, nothing sent", async () => {
    const id = await proposeId();
    mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it.each([
    ["the number", () => mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" })],
    // Same number, different person: the contact itself is pinned.
    ["the deal's contact", () => (mem.seed("contacts/c2", { ...ANN, name: "Ben" }), mem.seed("deals/d1", { ...DEAL, contactId: "c2" }))],
  ])("%s changed between the approve-time re-check and the write → failed, not completed, nothing sent", async (_label, change) => {
    const id = await proposeId();
    beforeNextTransaction(async () => change());
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The deal's contact or their number changed since this was reviewed; nothing was changed.");
    expect(mem.read("deals/d1")!.completed).toBeUndefined();
    expect(reviewAsk).not.toHaveBeenCalled();
  });
});
