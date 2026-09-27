import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { QUOTE } from "@/test/quote-fixtures";

/**
 * mark_quote_paid (PR11) through the real dispatch, decide route and
 * quotes-service: proposing records nothing and asks nothing; the approver
 * sees the amount, how it is recorded and the exact review request; approve
 * runs markQuotePaidServerSide once, and the review request is asked from
 * inside it (with the reviewed text as `expect`), never by the agent surface.
 */

const reviewAsk = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ sent: true })));
vi.mock("@/lib/reviews/request", async (orig) => ({ ...((await orig()) as object), maybeSendReviewRequest: reviewAsk }));
const markPaid = vi.hoisted(() => ({ spy: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock("@/lib/server/quotes-service", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/server/quotes-service");
  markPaid.spy = vi.fn(real.markQuotePaidServerSide);
  return { ...real, markQuotePaidServerSide: markPaid.spy };
});
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

const ACCEPTED = { ...QUOTE, status: "accepted" };
const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann Smith", phone: "+27821111111", email: "ann@x.io", territoryId: "global" };
const REVIEWS = {
  enabled: true, triggerOnQuotePaid: true, reviewUrl: "https://g.page/r/fixture/review", channel: "sms",
  messageTemplate: "Hi {{firstName}}, thanks from {{businessName}}! Review us: {{reviewUrl}}",
};
const SMS_TEXT = "Hi Ann, thanks from Acme! Review us: https://g.page/r/fixture/review";
const reviews = (patch: Record<string, unknown>) =>
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleReviewConfig: { ...REVIEWS, ...patch } });
const call = (args: Record<string, unknown> = {}) => dispatchAgentTool(auth, "mark_quote_paid", { quoteId: "q1", ...args });
async function proposeId(): Promise<string> {
  const r = await call();
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
/** After approve's claim: inside execute's first transaction (the paid compare-and-set). */
const inPaidWrite = (change: () => unknown) => beforeNextTransaction(async () => beforeNextTransaction(async () => { await change(); }));

beforeEach(() => {
  reviewAsk.mockClear();
  markPaid.spy.mockClear();
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "Acme", googleReviewConfig: REVIEWS });
  mem.seed("quotes/q1", ACCEPTED);
  mem.seed("contacts/c1", ANN);
});

describe("mark_quote_paid", () => {
  it("proposing records and asks nothing; approve marks it paid once and the review request comes from inside that call", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "Amount")).toBe("ZAR 500 in ZAR");
    expect(rowOf(id, "Recorded as")).toBe("paid by hand (no card or link payment is recorded)");
    expect(rowOf(id, "Review request")).toBe("Sent to Ann Smith (\u20261111) by SMS; quiet hours delay it.");
    expect(row(id).preview).toContainEqual({ label: "Message", value: SMS_TEXT, multiline: true });
    expect(row(id).preview).toContainEqual({ label: "Line items", value: "1 \u00d7 Install @ ZAR 500 = ZAR 500", multiline: true });
    expect(row(id).pinned).toEqual({
      quoteId: "q1", totalCents: 50000, currency: "ZAR", paidVia: null, contactId: "c1", phone: "+27821111111", channel: "sms", body: SMS_TEXT, fingerprint: null, workflows: [],
    });
    expect(markPaid.spy).not.toHaveBeenCalled();
    expect(reviewAsk).not.toHaveBeenCalled();
    expect(mem.read("quotes/q1")!.status).toBe("accepted");

    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("quotes/q1")!.status).toBe("paid");
    expect(markPaid.spy).toHaveBeenCalledTimes(1);
    expect(markPaid.spy.mock.calls[0]![0]).toMatchObject({ quoteId: "q1", expectSubAccountId: "sa1", expectTotalCents: 50000, expectCurrency: "ZAR" });
    expect(reviewAsk).toHaveBeenCalledTimes(1);
    expect(reviewAsk).toHaveBeenCalledWith({
      subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "quote_paid", expect: { phone: "+27821111111", channel: "sms", body: SMS_TEXT },
    });
    // Asked from inside markQuotePaidServerSide, before it returned.
    expect(reviewAsk.mock.invocationCallOrder[0]).toBeGreaterThan(markPaid.spy.mock.invocationCallOrder[0]!);
    expect(await markPaid.spy.mock.results[0]!.value).toMatchObject({ ok: true });
  });

  it("review requests off when reviewed, then turned on before approve -> failed, nothing marked or asked", async () => {
    reviews({ triggerOnQuotePaid: false });
    const id = await proposeId();
    expect(rowOf(id, "Review request")).toBe("None: review requests for paid quotes are off in this workspace.");
    beforeNextTransaction(async () => reviews({ triggerOnQuotePaid: true }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(reviewAsk).not.toHaveBeenCalled();
    expect(mem.read("quotes/q1")!.status).toBe("accepted");
  });

  it("review requests off: approve marks it paid and passes null, so the service asks nothing", async () => {
    reviews({ triggerOnQuotePaid: false });
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("quotes/q1")!.status).toBe("paid");
    expect(markPaid.spy.mock.calls[0]![0]).toMatchObject({ reviewExpect: null });
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it("a person marks it paid while the approved mark runs -> failed, and only the person's review request", async () => {
    const id = await proposeId();
    const { POST } = await import("@/app/api/sub-accounts/[id]/quotes/[quoteId]/mark-paid/route");
    inPaidWrite(async () => {
      const res = await POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "sa1", quoteId: "q1" }) });
      expect(res.status).toBe(200);
    });
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("It was marked paid meanwhile (by someone else); nothing more was done.");
    expect(reviewAsk).toHaveBeenCalledTimes(1);
    expect(reviewAsk.mock.calls[0]![0]).not.toHaveProperty("expect");
  });

  it("the total changed inside the paid write's transaction -> failed, not paid, nothing asked", async () => {
    const id = await proposeId();
    inPaidWrite(() => mem.seed("quotes/q1", { ...ACCEPTED, lineItems: [{ ...ACCEPTED.lineItems[0], unitPrice: 5 }] }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The total or currency changed since this was reviewed; it was not marked paid.");
    expect(mem.read("quotes/q1")!.status).toBe("accepted");
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it("the quote's contact changed inside the paid write's transaction -> failed, not paid, nothing asked", async () => {
    const id = await proposeId();
    inPaidWrite(() => (mem.seed("contacts/c2", ANN), mem.seed("quotes/q1", { ...ACCEPTED, contactId: "c2" })));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The quote's contact changed since this was reviewed; it was not marked paid.");
    expect(mem.read("quotes/q1")!.status).toBe("accepted");
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it.each([
    ["the contact's number", () => mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" })],
    ["the currency", () => mem.seed("quotes/q1", { ...ACCEPTED, currency: "USD" })],
    ["a Paystack link payment", () => mem.seed("paymentLinks/pl1", { subAccountId: "sa1", invoiceId: "q1", status: "paid", paystackReference: "ref1" })],
  ])("%s changed after the approver's preview check -> failed, nothing written or asked", async (_label, change) => {
    const id = await proposeId();
    beforeNextTransaction(async () => change());
    expect((await decide(id, "approve")).status).toBe(422);
    expect(markPaid.spy).not.toHaveBeenCalled();
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it("an unsettled Paystack link payment is shown and recorded as the payer", async () => {
    mem.seed("quotes/q1", { ...ACCEPTED, kind: "invoice", status: "sent" });
    mem.seed("paymentLinks/pl1", { subAccountId: "sa1", invoiceId: "q1", status: "paid", paystackReference: "ref1" });
    const id = await proposeId();
    expect(rowOf(id, "Recorded as")).toBe("paid by the Paystack payment link already paid for it (ref1)");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("quotes/q1")!.paidVia).toEqual({ rail: "paystack_link", linkId: "pl1", reference: "ref1" });
  });

  it.each([
    ["a draft quote", { status: "draft" }, "Only an accepted quote can be marked paid (this one is draft)."],
    ["a draft invoice", { kind: "invoice", status: "draft" }, "Only a sent invoice can be marked paid (this one is draft)."],
    ["a paid quote", { status: "paid" }, "That quote is already paid."],
    ["another sub-account's quote", { subAccountId: "sa2" }, "That quote or invoice isn't in this workspace."],
  ])("%s -> refused at propose", async (_label, patch, message) => {
    mem.seed("quotes/q1", { ...ACCEPTED, ...patch });
    expect(await call()).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  describe("the quote.paid workflows it starts", () => {
    const seedPaidWorkflow = (body = "Thanks for paying") =>
      mem.seed("workflows/wf_paid", {
        name: "After payment", subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
        trigger: { type: "quote.paid", filters: { all: [] } }, nodes: { n1: { id: "n1", type: "send_sms", config: { body }, next: null } },
      });

    it("are shown and pinned with their steps' fingerprint", async () => {
      seedPaidWorkflow();
      const id = await proposeId();
      expect(rowOf(id, "Workflows that start")).toBe("After payment (wf_paid)");
      expect(row(id).pinned).toMatchObject({ workflows: [{ id: "wf_paid", stepsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
    });

    it("steps edited after the proposal -> preview_changed, not marked paid", async () => {
      seedPaidWorkflow();
      const id = await proposeId();
      seedPaidWorkflow("Pay us more");
      expect(await (await decide(id, "approve")).json()).toMatchObject({ error: "preview_changed" });
      expect(mem.read("quotes/q1")!.status).toBe("accepted");
    });

    it("steps edited after the approver's preview check -> failed, not marked paid", async () => {
      seedPaidWorkflow();
      const id = await proposeId();
      beforeNextTransaction(async () => seedPaidWorkflow("Pay us more"));
      expect((await decide(id, "approve")).status).toBe(422);
      expect(mem.read("quotes/q1")!.status).toBe("accepted");
      expect(markPaid.spy).not.toHaveBeenCalled();
    });
  });
});
