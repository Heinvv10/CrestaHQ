import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { REVIEWS, seedPr13 } from "@/test/pr13-fixtures";

/**
 * The PR13 reputation capabilities through the real dispatch and decide
 * route: the reviews reads, and send_review_request as an outbound proposal
 * with the exact text, recipient and channel (and when they were last asked),
 * sent on approve through the review sender with that text as `expect`.
 */

const reviewAsk = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ sent: true }) as { sent: boolean; reason?: string }));
vi.mock("@/lib/reviews/request", async (orig) => ({ ...((await orig()) as object), maybeSendReviewRequest: reviewAsk }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann Smith", phone: "+27821111111", territoryId: "global" };
const SMS_TEXT = "Hi Ann, thanks from Acme! Review us: https://g.page/r/fixture/review";
const call = (name: string, args: Record<string, unknown> = {}) => dispatchAgentTool(auth, name, args);
async function proposeId(): Promise<string> {
  const r = await call("send_review_request", { contactId: "c1" });
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;

beforeEach(() => {
  reviewAsk.mockClear();
  seedPr13(mem);
  mem.seed("contacts/c1", ANN);
});

describe("reputation reads", () => {
  it("overview and list read the synced listing", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleListing: { locationName: "locations/1" } });
    expect(await call("reputation_overview")).toMatchObject({ ok: true, resultText: expect.stringContaining("Synced reviews: 0") });
    expect(await call("list_reviews")).toMatchObject({ ok: true, resultText: "No synced reviews." });
  });

  it("Google locked by the agency -> refused", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleEnabledByAgency: false });
    expect(await call("list_reviews")).toMatchObject({ ok: false, message: "Google reviews are locked by your agency." });
  });
});

describe("send_review_request", () => {
  it("an outbound proposal with the exact text, last asked and opt-out; approve sends through the review sender with it", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "Review request")).toBe("Sent to Ann Smith (\u20261111) by SMS when approved (quiet hours don't hold a request a person sends).");
    expect(row(id).preview).toContainEqual({ label: "Message", value: SMS_TEXT, multiline: true });
    expect(rowOf(id, "Last asked")).toBe("never (at most once every 90 days)");
    expect(rowOf(id, "Opted out of SMS")).toBe("no");
    expect(reviewAsk).not.toHaveBeenCalled();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(reviewAsk).toHaveBeenCalledWith({
      subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "manual", actorUid: "u_admin",
      expect: { phone: "+27821111111", channel: "sms", body: SMS_TEXT },
    });
  });

  it.each([
    ["asked within the cooldown", () => mem.seed("contacts/c1", { ...ANN, reviewRequestedAt: Timestamp.fromMillis(Date.now() - 86_400_000) }), "No review request can be sent: the contact was asked for a review in the last 90 days."],
    ["an SMS opt-out", () => mem.seed("contacts/c1", { ...ANN, smsOptedOut: true }), "No review request can be sent: the contact has opted out of SMS."],
    ["no review link set up", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleReviewConfig: { ...REVIEWS, reviewUrl: "" } }), "No review request can be sent: review requests aren't set up in this workspace."],
    ["another sub-account's contact", () => mem.seed("contacts/c1", { ...ANN, subAccountId: "sa2" }), "That contact isn't in this workspace."],
  ])("%s -> refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call("send_review_request", { contactId: "c1" })).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("the number changed after the approver's preview check -> failed, nothing sent", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it("the sender refuses (changed at send time) -> failed", async () => {
    reviewAsk.mockResolvedValueOnce({ sent: false, reason: "changed_since_approval" });
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(422);
  });

  it("a provider error -> unsettled (it may have left), never failed", async () => {
    reviewAsk.mockResolvedValueOnce({ sent: false, reason: "send_failed" });
    const id = await proposeId();
    await decide(id, "approve");
    expect(row(id).status).toBe("unsettled");
  });
});
