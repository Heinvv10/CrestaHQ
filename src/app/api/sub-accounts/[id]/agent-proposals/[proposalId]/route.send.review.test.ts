import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * PR #273 review items for send_message, through the real dispatch and
 * decide route with the conversation-send seam spied: consent at propose and
 * at approve, the 502 rule, link-safe bodies, the email envelope and
 * threading, the WhatsApp idempotency key, and the pinned-value guards.
 */

const send = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, messageId: "M1", response: {} }))
);
vi.mock("@/lib/server/conversation-send", async (orig) => ({ ...((await orig()) as object), sendConversationMessage: send }));
vi.mock("@/lib/reviews/review-ask", async (orig) => ({ ...((await orig()) as object), logInboxReviewAsk: async () => undefined }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");
const { buildAgentContext } = await import("@/lib/api/agent-context");

const ANN = { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", email: "ann@x.io", territoryId: "global" };
beforeEach(() => {
  send.mockClear();
  mem.seed("contacts/c1", ANN);
  mem.seed("conversations/c1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann", territoryId: "global" });
});
const propose = (args: Record<string, unknown>) => dispatchAgentTool(auth, "send_message", { conversationId: "c1", ...args });
async function proposeId(args: Record<string, unknown>) {
  const r = await propose(args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}

describe("consent", () => {
  it.each([
    ["email", { emailOptedOut: true }, { channel: "email", subject: "Hi", body: "x" }, "This contact has opted out of email."],
    ["sms", { smsOptedOut: true }, { channel: "sms", body: "x" }, "This contact has opted out of SMS (replied STOP)."],
  ])("an %s opt-out refuses the proposal", async (_label, optOut, args, message) => {
    mem.seed("contacts/c1", { ...ANN, ...optOut });
    expect(await propose(args)).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it.each([
    ["email", { emailOptedOut: true }, { channel: "email", subject: "Hi", body: "x" }, "This contact has opted out of email."],
    ["sms", { smsOptedOut: true }, { channel: "sms", body: "x" }, "This contact has opted out of SMS (replied STOP)."],
  ])("an %s opt-out after the proposal: the approver sees it, and approving anyway fails with 0 sends", async (_label, optOut, args, message) => {
    const id = await proposeId(args);
    expect(row(id).preview).toContainEqual({ label: "Consent", value: `Not opted out of ${args.channel}.` });
    mem.seed("contacts/c1", { ...ANN, ...optOut });
    const first = await decide(id, "approve");
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: "preview_changed" });
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: message });
    expect(send).not.toHaveBeenCalled();
  });
});

it("a 502 from the seam → unsettled, never failed", async () => {
  send.mockResolvedValueOnce({ ok: false, status: 502, error: "Bad gateway" });
  const id = await proposeId({ channel: "sms", body: "x" });
  expect((await decide(id, "approve")).status).toBe(202);
  expect(row(id).status).toBe("unsettled");
});

describe("bodies", () => {
  it("a joiner inside a link is refused; a ZWJ emoji sequence is fine", async () => {
    expect(await propose({ channel: "sms", body: "Pay at https://ba\u200cnk.co.za/pay" })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await propose({ channel: "sms", body: "Hi \u{1F468}\u200d\u{1F469}\u200d\u{1F467}" })).toMatchObject({ ok: true });
  });

  it.each([["too long", "x".repeat(201)], ["unsafe", "Hi\u200b"]])("a subject that is %s is refused", async (_label, subject) => {
    expect(await propose({ channel: "email", subject, body: "x" })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("email", () => {
  it("shows From / Reply-To, threads onto the newest email, and sends that subject and threading", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, replyToEmail: "help@acme.io" });
    mem.seed("contacts/c1/emailMessages/e1", {
      subAccountId: "sa1", direction: "inbound", subject: "Quote", messageId: "<m1@x.io>", inReplyTo: null, references: [], createdAt: new Date(),
    });
    const id = await proposeId({ channel: "email", subject: "Re: Quote", body: "Attached." });
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "From", value: "the workspace's default sender" },
      { label: "Reply-To", value: "help@acme.io" },
    ]));
    expect((await decide(id, "approve")).status).toBe(200);
    expect(send.mock.calls[0]![0]).toMatchObject({
      channel: "email", subject: "Re: Quote", body: "Attached.", inReplyTo: "<m1@x.io>", references: ["<m1@x.io>"],
    });
  });
});

describe("breaker round 2", () => {
  it.each([
    ["U+2065", "a\u2065b"], ["U+FFF0", "a\ufff0b"], ["U+E0080", "a\u{e0080}b"], ["U+E01F0", "a\u{e01f0}b"], ["U+E0000", "a\u{e0000}b"],
  ])("a body with the unassigned default-ignorable %s is refused", async (_label, body) => {
    expect(await propose({ channel: "sms", body })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("a legacy email doc without references can still be replied to; the thread is shown", async () => {
    mem.seed("contacts/c1/emailMessages/e0", {
      subAccountId: "sa1", direction: "inbound", subject: "Old\nthread", messageId: "<old@x.io>", inReplyTo: null, createdAt: new Date("2026-01-02T03:04:05.000Z"),
    });
    const id = await proposeId({ channel: "email", subject: "Re: Old thread", body: "Hi" });
    expect(row(id).preview).toContainEqual({ label: "In reply to", value: "Old thread (2026-01-02T03:04:05.000Z)" });
    expect(row(id).pinned).toMatchObject({ inReplyTo: "<old@x.io>", references: ["<old@x.io>"] });
  });

  it("a newer email since the proposal changes the visible In reply to row", async () => {
    mem.seed("contacts/c1/emailMessages/e0", { subAccountId: "sa1", subject: "First", messageId: "<a@x.io>", references: [], createdAt: new Date(1000) });
    const id = await proposeId({ channel: "email", subject: "Re", body: "Hi" });
    mem.seed("contacts/c1/emailMessages/e1", { subAccountId: "sa1", subject: "Second", messageId: "<b@x.io>", references: [], createdAt: new Date(2000) });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect((await res.json()).preview).toContainEqual({ label: "In reply to", value: expect.stringContaining("Second") });
    expect(send).not.toHaveBeenCalled();
  });
});

it("a WhatsApp send carries the per-approval idempotency key", async () => {
  const id = await proposeId({ channel: "whatsapp", body: "Hi" });
  await decide(id, "approve");
  expect(send.mock.calls[0]![0]).toMatchObject({ idempotencyKey: `agent_${id}_${row(id).claimId}` });
});

describe("pinned-value guards", () => {
  const args = { conversationId: "c1", channel: "sms", body: "x" };
  it.each([
    ["the channel", { contactId: "c1", channel: "whatsapp", to: "+27821111111" }],
    ["the contact", { contactId: "c9", channel: "sms", to: "+27821111111" }],
  ])("a pin that doesn't match %s is refused, 0 sends", async (_label, pinned) => {
    await expect(getCapability("send_message")!.execute({ ...buildAgentContext(auth), approved: { pinned } }, args))
      .rejects.toBeInstanceOf(CapabilityUserError);
    expect(send).not.toHaveBeenCalled();
  });
});
