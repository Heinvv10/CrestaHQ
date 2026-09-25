import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * send_message through the real dispatch and decide route, with the
 * conversation-send seam spied: nothing is sent on propose; approve sends
 * exactly once, to the PINNED recipient, as the approver; a recipient that
 * changed is refused (at the preview re-check, or at execute if it changed in
 * between); the seam's refusal settles the row `failed` with its error, and
 * an unknown outcome leaves it `unsettled`.
 */

const send = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, messageId: "SM1", response: {} }))
);
vi.mock("@/lib/server/conversation-send", async (orig) => ({ ...((await orig()) as object), sendConversationMessage: send }));
const reviewAsk = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock("@/lib/reviews/review-ask", async (orig) => ({ ...((await orig()) as object), logInboxReviewAsk: reviewAsk }));
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
  reviewAsk.mockClear();
  mem.seed("contacts/c1", ANN);
  mem.seed("conversations/c1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann", territoryId: "global" });
});
async function proposeSms(body = "Your install is booked for Tuesday.") {
  const r = await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "sms", body });
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const sentTo = () => send.mock.calls.map(([input]) => (input as { contact: { phone: string } }).contact.phone);

describe("propose", () => {
  it("queues the full body, channel and masked recipient; pins the exact number; sends nothing", async () => {
    const id = await proposeSms();
    expect(row(id).preview).toEqual([
      { label: "To", value: "Ann (…1111)" },
      { label: "Channel", value: "sms" },
      { label: "Consent", value: "Not opted out of sms." },
      { label: "When", value: "Sends immediately when approved (quiet hours don't hold it)." },
      { label: "Message", value: "Your install is booked for Tuesday.", multiline: true },
    ]);
    expect(row(id)).toMatchObject({ approval: "outbound", contactId: "c1", pinned: { contactId: "c1", channel: "sms", to: "+27821111111" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("a multi-line body is shown exactly as sent (CRLF normalised), and that is what is sent", async () => {
    const r = await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "sms", body: "Hi Ann,\r\n\nSee you Tuesday." });
    if (!("proposal" in r)) throw new Error("expected a proposal");
    expect(row(r.proposal.id).preview).toContainEqual({ label: "Message", value: "Hi Ann,\n\nSee you Tuesday.", multiline: true });
    expect((await decide(r.proposal.id, "approve")).status).toBe(200);
    expect(send.mock.calls[0]![0]).toMatchObject({ body: "Hi Ann,\n\nSee you Tuesday." });
  });

  it.each([
    ["a bidi override", "Pay \u202e0001 ZAR"], ["a zero-width space", "Hi\u200bAnn"],
    ["a NUL", "Hi\u0000"], ["a file separator", "Hi\u001cAnn"], ["a tab", "Hi\tAnn"],
  ])("a body with %s is refused, not stripped", async (_label, body) => {
    expect(await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "sms", body }))
      .toMatchObject({ ok: false, code: "invalid_args" });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it.each([
    ["U+FE0E", "a\ufe0eb"], ["U+E0101", "a\u{e0101}b"], ["U+17B4", "a\u17b4b"], ["U+180B", "a\u180bb"],
  ])("a body with the invisible mark %s is refused", async (_label, body) => {
    expect(await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "sms", body }))
      .toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("U+FE0F (emoji presentation) in a body is fine", async () => {
    expect(await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "sms", body: "Thanks \u2764\ufe0f" }))
      .toMatchObject({ ok: true, proposal: { status: "pending" } });
  });

  it("the email subject stored (and sent) is the one-line form the approver reads; an unsafe one is refused", async () => {
    const r = await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "email", subject: " Your\n  quote\tis ready ", body: "Hi" });
    if (!("proposal" in r)) throw new Error("expected a proposal");
    expect(row(r.proposal.id)).toMatchObject({ args: { subject: "Your quote is ready" } });
    expect(row(r.proposal.id).preview).toContainEqual({ label: "Subject", value: "Your quote is ready" });
    expect(await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "email", subject: "Hi\u202e", body: "x" }))
      .toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("another sub-account's conversation → refused, nothing written or sent", async () => {
    mem.seed("contacts/c2", { ...ANN, subAccountId: "sa2" });
    mem.seed("conversations/c2", { subAccountId: "sa2", agencyId: "ag1", contactId: "c2", contactName: "Bob" });
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, "send_message", { conversationId: "c2", channel: "sms", body: "x" }))
      .toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
    expect(send).not.toHaveBeenCalled();
  });

  it("an email needs a subject; a contact without the channel's address is refused", async () => {
    expect(await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "email", body: "x" })).toMatchObject({ ok: false, code: "invalid_args" });
    mem.seed("contacts/c1", { ...ANN, phone: "" });
    expect(await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "sms", body: "x" })).toMatchObject({ ok: false, message: "This contact has no phone number." });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("approve", () => {
  it("sends exactly once, to the pinned number, as the approver", async () => {
    const id = await proposeSms();
    const res = await decide(id, "approve");
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      channel: "sms", contactId: "c1", body: "Your install is booked for Tuesday.",
      contact: { phone: "+27821111111" }, actor: { uid: "u_admin", email: "admin@x.io" }, humanReply: false,
    });
    expect(row(id)).toMatchObject({ status: "executed", result: { ref: { kind: "message", id: "SM1" } } });
  });

  it("two concurrent approves → one send", async () => {
    const id = await proposeSms();
    expect((await Promise.all([decide(id, "approve"), decide(id, "approve")])).map((r) => r.status).sort()).toEqual([200, 409]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the number changed since the proposal → preview_changed, nothing sent", async () => {
    const id = await proposeSms();
    mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("the number changed between the re-check and the send → failed, nothing sent", async () => {
    const id = await proposeSms();
    beforeNextTransaction(async () => mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" }));
    const res = await decide(id, "approve");
    expect(res.status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "The recipient changed since this was reviewed; nothing was sent." });
    expect(send).not.toHaveBeenCalled();
  });

  it("a seam refusal → the row is failed with the seam's error", async () => {
    send.mockResolvedValueOnce({ ok: false, status: 409, error: "This contact has opted out of SMS (replied STOP)." });
    const id = await proposeSms();
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "This contact has opted out of SMS (replied STOP)." });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("REPRO 1: the seam throws after delivery (bookkeeping) → unsettled, audited, and a re-propose can't send again", async () => {
    send.mockRejectedValueOnce(new Error("upsertConversationForMessage failed"));
    const id = await proposeSms();
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id).status).toBe("unsettled");
    expect(mem.list("aiSuiteActions")).toEqual([expect.objectContaining({ agentProposalId: id, status: "unknown" })]);
    const again = await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "sms", body: "Your install is booked for Tuesday." });
    expect(again).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("REPRO 2: the provider was contacted and then failed (attempted) → unsettled, never failed", async () => {
    send.mockResolvedValueOnce({ ok: false, status: 502, error: "socket hang up", attempted: true });
    const id = await proposeSms();
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id)).toMatchObject({ status: "unsettled", unsettledReason: "socket hang up" });
  });

  it.each([
    ["outcomeUnknown", { ok: false, status: 409, error: "WhatsApp said AMBIGUOUS", outcomeUnknown: true }],
    ["attempted", { ok: false, status: 409, error: "Provider rejected after contact", attempted: true }],
  ])("a non-502 %s refusal → unsettled, never failed", async (_label, outcome) => {
    send.mockResolvedValueOnce(outcome);
    const id = await proposeSms();
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id).status).toBe("unsettled");
  });

  it("the unknown-outcome audit row failing to write still answers the approve (logged, row unsettled)", async () => {
    send.mockResolvedValueOnce({ ok: false, status: 502, error: "maybe", outcomeUnknown: true });
    const id = await proposeSms();
    const realCollection = mem.db.collection.bind(mem.db);
    vi.spyOn(mem.db, "collection").mockImplementation(((path: string) =>
      path === "aiSuiteActions"
        ? { ...realCollection(path), add: () => Promise.reject(new Error("audit write failed")) }
        : realCollection(path)) as never);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id).status).toBe("unsettled");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("unknown-outcome audit"), expect.any(Error));
  });

  it("an email send logs its review ask with [subject, body]", async () => {
    const r = await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "email", subject: "Your quote", body: "Attached." });
    if (!("proposal" in r)) throw new Error("expected a proposal");
    await decide(r.proposal.id, "approve");
    expect(reviewAsk).toHaveBeenCalledWith(expect.objectContaining({ channel: "email", parts: ["Your quote", "Attached."] }));
  });

  it("the When row is channel-aware: WhatsApp's bridge quiet hours can refuse it", async () => {
    const r = await dispatchAgentTool(auth, "send_message", { conversationId: "c1", channel: "whatsapp", body: "Hi" });
    if (!("proposal" in r)) throw new Error("expected a proposal");
    expect(row(r.proposal.id).preview).toContainEqual({
      label: "When", value: "Sends when approved, unless the WhatsApp bridge's quiet hours refuse it (then it fails and nothing is sent).",
    });
  });

  it("a successful send logs the review request like the human route", async () => {
    const id = await proposeSms();
    await decide(id, "approve");
    expect(reviewAsk).toHaveBeenCalledWith(expect.objectContaining({
      channel: "sms", parts: ["Your install is booked for Tuesday."], actorUid: "u_admin",
      outcome: { ok: true, messageSid: "SM1" }, contact: expect.objectContaining({ id: "c1", phone: "+27821111111" }),
    }));
  });

  it("an unknown delivery outcome → unsettled (never failed), for a person to check", async () => {
    send.mockResolvedValueOnce({ ok: false, status: 502, error: "The provider didn't confirm delivery.", outcomeUnknown: true });
    const id = await proposeSms();
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id)).toMatchObject({ status: "unsettled", unsettledReason: "The provider didn't confirm delivery." });
  });
});

describe("execute guards", () => {
  it("never runs outside an approval, or without a pinned recipient", async () => {
    const cap = getCapability("send_message")!;
    const args = { conversationId: "c1", channel: "sms", body: "x" };
    await expect(cap.execute(buildAgentContext(auth), args)).rejects.toBeInstanceOf(CapabilityUserError);
    await expect(cap.execute({ ...buildAgentContext(auth), approved: { pinned: null } }, args)).rejects.toBeInstanceOf(CapabilityUserError);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends to the pinned number", async () => {
    const cap = getCapability("send_message")!;
    await cap.execute(
      { ...buildAgentContext(auth), approved: { pinned: { contactId: "c1", channel: "sms", to: "+27821111111" } } },
      { conversationId: "c1", channel: "sms", body: "x" }
    );
    expect(sentTo()).toEqual(["+27821111111"]);
  });
});
