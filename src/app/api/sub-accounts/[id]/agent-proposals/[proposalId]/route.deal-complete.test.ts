import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
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
const REVIEWS = {
  enabled: true, triggerOnDealCompleted: true, reviewUrl: "https://g.page/r/fixture/review", channel: "sms",
  messageTemplate: "Hi {{firstName}}, thanks from {{businessName}}! Review us: {{reviewUrl}}",
};
const SMS_TEXT = "Hi Ann, thanks from Acme! Review us: https://g.page/r/fixture/review";
const reviews = (patch: Record<string, unknown>) =>
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, googleReviewConfig: { ...REVIEWS, ...patch } });
const call = (args: Record<string, unknown> = {}) => dispatchAgentTool(auth, "mark_deal_completed", { dealId: "d1", ...args });
async function proposeId(): Promise<string> {
  const r = await call();
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const reviewRow = (id: string) => rowOf(id, "Review request");
/** A write-transaction hook one transaction later than beforeNextTransaction:
 *  after approve's claim, between execute's reads and its deal write. */
const inExecuteWindow = (change: () => unknown) => beforeNextTransaction(async () => beforeNextTransaction(async () => { await change(); }));

beforeEach(() => {
  reviewAsk.mockClear();
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "Acme", googleReviewConfig: REVIEWS });
  mem.seed("deals/d1", DEAL);
  mem.seed("contacts/c1", ANN);
});

describe("mark_deal_completed", () => {
  it("proposing sends nothing and names the review request's recipient; approve completes and asks exactly once", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(reviewRow(id)).toBe("Sent to Ann Smith (…1111) by SMS; quiet hours delay it.");
    expect(row(id).preview).toContainEqual({ label: "Message", value: SMS_TEXT, multiline: true });
    expect(row(id).pinned).toEqual({ dealId: "d1", contactId: "c1", phone: "+27821111111", channel: "sms", body: SMS_TEXT });
    expect(row(id).preview).toContainEqual({ label: "Stage", value: "Won (Won stage)" });
    expect(reviewAsk).not.toHaveBeenCalled();
    expect(mem.read("deals/d1")!.completed).toBeUndefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("deals/d1")!.completed).toBe(true);
    expect(reviewAsk).toHaveBeenCalledTimes(1);
    expect(reviewAsk).toHaveBeenCalledWith({
      subAccountId: "sa1", agencyId: "ag1", contactId: "c1", trigger: "deal_completed", expect: { phone: "+27821111111", channel: "sms", body: SMS_TEXT },
    });
  });

  it.each([
    ["review requests off", () => reviews({ triggerOnDealCompleted: false }), "None: review requests for completed deals are off in this workspace."],
    ["no review link", () => reviews({ reviewUrl: "" }), "None: review requests for completed deals are off in this workspace."],
    ["a contact with no phone", () => mem.seed("contacts/c1", { ...ANN, phone: "" }), "None: the deal's contact has no phone number."],
    ["an SMS opt-out", () => mem.seed("contacts/c1", { ...ANN, smsOptedOut: true }), "None: the contact has opted out of SMS."],
    ["a WhatsApp opt-out", () => (reviews({ channel: "whatsapp_manual" }), mem.seed("contacts/c1", { ...ANN, whatsappOptedOut: true })), "None: the contact has opted out of WhatsApp."],
    ["a request within the cooldown", () => mem.seed("contacts/c1", { ...ANN, reviewRequestedAt: Timestamp.fromMillis(Date.now() - 86_400_000) }), "None: the contact was asked for a review in the last 90 days."],
    ["no WhatsApp template set", () => reviews({ channel: "whatsapp_template" }), "None: no WhatsApp review template is set."],
    ["a template with spacing a message would tidy", () => reviews({ messageTemplate: "Hi {{firstName}}   \n{{reviewUrl}}" }), "None: the review request's text has spacing that can't be shown exactly as sent."],
    ["a template with a hidden character", () => reviews({ messageTemplate: "Hi\u200b{{firstName}} {{reviewUrl}}" }), "None: the review request's text contains characters that can't be shown safely."],
  ])("%s → the preview says so, with no message", async (_label, arrange, text) => {
    arrange();
    const id = await proposeId();
    expect(reviewRow(id)).toBe(text);
    expect(rowOf(id, "Message")).toBeUndefined();
  });

  it.each([
    ["free-form WhatsApp", () => reviews({ channel: "whatsapp_manual" }), "WhatsApp", SMS_TEXT],
    ["a WhatsApp template", () => {
      reviews({ channel: "whatsapp_template", whatsappTemplateId: "rt1" });
      mem.seed("subAccounts/sa1/whatsappTemplates/rt1", {
        name: "review", body: "Hi {{1}}, please review {{2}}", status: "approved",
        variables: [
          { position: 1, label: "Name", sampleValue: "Ben", source: "merge_tag", mergeTag: "contact.firstName" },
          { position: 2, label: "Biz", sampleValue: "Co", source: "merge_tag", mergeTag: "workspace.name" },
        ],
      });
    }, "WhatsApp", "Hi Ann, please review Acme"],
  ])("%s → the exact text in the preview", async (_label, arrange, channel, text) => {
    arrange();
    const id = await proposeId();
    expect(reviewRow(id)).toBe(`Sent to Ann Smith (…1111) by ${channel}; quiet hours delay it.`);
    expect(rowOf(id, "Message")).toBe(text);
  });

  it("reminders on: the preview says none will follow, and nothing hints at a tracking link", async () => {
    reviews({ reminder: { everyDays: 3, maxRetries: 2 } });
    const id = await proposeId();
    expect(rowOf(id, "Reminders")).toBe("No reminders will follow (reminders apply only to requests people send).");
    expect(JSON.stringify(row(id).preview)).not.toContain("tracking");
    expect(rowOf(id, "Message")).toBe(SMS_TEXT);
  });

  it("the message template changed since the proposal → preview_changed, nothing sent", async () => {
    const id = await proposeId();
    reviews({ messageTemplate: "New words {{reviewUrl}}" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(reviewAsk).not.toHaveBeenCalled();
    expect(mem.read("deals/d1")!.completed).toBeUndefined();
  });

  it("a pipeline an agent last edited → a warning that its Won stage may be the agent's", async () => {
    mem.seed("subAccounts/sa1/pipelines/default", {
      subAccountId: "sa1", agencyId: "ag1", name: "Default", isDefault: true, lastAgentEditKey: "abcd1234", lastAgentEditAt: Timestamp.fromMillis(Date.UTC(2030, 0, 1)),
      stages: [{ id: "new", label: "New", tone: "" }, { id: "won", label: "Won", tone: "", terminal: "won" }],
    });
    expect(rowOf(await proposeId(), "Warning")).toBe(
      "API agent abcd1234 last edited this pipeline at 2030-01-01T00:00:00.000Z: its stage names and which stage counts as Won may be the agent's."
    );
  });

  it("completed by someone else between execute's read and its write → no second review request", async () => {
    const id = await proposeId();
    inExecuteWindow(() => mem.seed("deals/d1", { ...DEAL, completed: true }));
    expect((await decide(id, "approve")).status).toBe(200);
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it("review requests off when reviewed: approve completes the deal and asks for nothing", async () => {
    reviews({ triggerOnDealCompleted: false });
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("deals/d1")!.completed).toBe(true);
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it("the deal's contact changed inside the write's window → failed, not completed, nothing sent", async () => {
    const id = await proposeId();
    inExecuteWindow(() => (mem.seed("contacts/c2", { ...ANN, name: "Ben" }), mem.seed("deals/d1", { ...DEAL, contactId: "c2" })));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The deal's contact changed since this was reviewed; it was not marked completed.");
    expect(mem.read("deals/d1")!.completed).toBeUndefined();
    expect(reviewAsk).not.toHaveBeenCalled();
  });

  it("a person ticks completed while the approved completion runs → exactly one review request in all", async () => {
    const { PATCH } = await import("@/app/api/deals/[id]/route");
    const id = await proposeId();
    inExecuteWindow(async () => {
      const res = await PATCH(new Request("http://x/api/deals/d1", { method: "PATCH", body: JSON.stringify({ completed: true }) }), {
        params: Promise.resolve({ id: "d1" }),
      });
      expect(res.status).toBe(200);
    });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(reviewAsk).toHaveBeenCalledTimes(1);
  });

  it("moved out of Won between execute's read and its write → failed, not completed, nothing sent", async () => {
    const id = await proposeId();
    inExecuteWindow(() => mem.seed("deals/d1", { ...DEAL, stageId: "new" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The deal is no longer on a Won stage; it was not marked completed.");
    expect(mem.read("deals/d1")!.completed).toBeUndefined();
    expect(reviewAsk).not.toHaveBeenCalled();
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
    ["the review request's text", () => reviews({ messageTemplate: "Other words {{reviewUrl}}" })],
    ["the review request's channel (same text)", () => reviews({ channel: "whatsapp_manual" })],
    // Same number, different person: the contact itself is pinned.
    ["the deal's contact", () => (mem.seed("contacts/c2", { ...ANN, name: "Ben" }), mem.seed("deals/d1", { ...DEAL, contactId: "c2" }))],
  ])("%s changed between the approve-time re-check and the write → failed, not completed, nothing sent", async (_label, change) => {
    const id = await proposeId();
    beforeNextTransaction(async () => change());
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The deal's contact, their number or the review request changed since this was reviewed; nothing was changed.");
    expect(mem.read("deals/d1")!.completed).toBeUndefined();
    expect(reviewAsk).not.toHaveBeenCalled();
  });
});
