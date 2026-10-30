import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { NextResponse } from "next/server";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * schedule_message through the real dispatch and decide route, and the real
 * scheduled-message service and fire worker, with the send seam, QStash and
 * the fire-time access check stubbed: propose books nothing; approve books
 * exactly one pinned message as the approver; the worker refuses when the
 * recipient changed or consent was revoked before it fires.
 */

const send = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, messageId: "SM1", response: {} })));
const publish = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<{ messageId: string } | null> => ({ messageId: "q1" })));
vi.mock("@/lib/server/conversation-send", async (orig) => ({
  ...((await orig()) as object),
  sendConversationMessage: send,
  precheckConversationMessage: async () => null,
}));
vi.mock("@/lib/automations/qstash", async (orig) => ({ ...((await orig()) as object), publishCallback: publish, qstashIsConfigured: () => true }));
vi.mock("@/lib/reviews/review-ask", async (orig) => ({ ...((await orig()) as object), logInboxReviewAsk: async () => undefined }));
vi.mock("@/lib/comms/route-auth", async (orig) => ({
  ...((await orig()) as object),
  requireContactAccessible: async (_uid: string, id: string) => {
    const { mem: m } = await import("@/test/agent-proposals-harness");
    const c = m.read(`contacts/${id}`);
    return c ? { id, ...c } : NextResponse.json({ error: "nf" }, { status: 404 });
  },
}));
vi.mock("@/lib/firebase/admin", async () => ({
  ...(await (await import("@/test/agent-proposals-harness")).adminMock()),
  getAdminAuth: () => ({ getUser: async () => ({ email: "admin@x.io" }) }),
}));
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

await setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { fireScheduledMessage } = await import("@/lib/server/scheduled-messages/fire");

const ANN = { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", email: "ann@x.io", territoryId: "global" };
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
beforeEach(() => {
  send.mockClear();
  publish.mockClear();
  mem.seed("contacts/c1", ANN);
  mem.seed("conversations/c1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann", territoryId: "global" });
});
const booked = () => mem.list("contacts/c1/scheduledMessages");
async function proposeId(args: Record<string, unknown> = {}) {
  const r = await dispatchAgentTool(auth, "schedule_message", { conversationId: "c1", channel: "sms", body: "Your install is tomorrow.", sendAt: inAnHour(), ...args });
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}

describe("propose", () => {
  it("books nothing and sends nothing; shows the time in the workspace zone and ISO; pins the number", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, timezone: "Africa/Johannesburg" });
    const sendAt = "2030-01-10T08:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-10T06:00:00.000Z"));
    const id = await proposeId({ sendAt });
    vi.useRealTimers();
    expect(row(id).preview).toEqual(expect.arrayContaining([
      { label: "When", value: expect.stringMatching(/10:00 AM \(Africa\/Johannesburg\) — 2030-01-10T08:00:00\.000Z$/) },
      { label: "Then", value: "Fires at that time; the recipient and the number it goes out from are re-checked then, and it won't send if either changed. SMS has no quiet hours; it sends at that time." },
      { label: "Message", value: "Your install is tomorrow.", multiline: true },
    ]));
    expect(row(id).pinned).toMatchObject({ contactId: "c1", channel: "sms", to: "+27821111111" });
    expect(booked()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["email", { subject: "Hi" }, "Email has no quiet hours; it sends at that time."],
    ["whatsapp", {}, "It fails without sending if WhatsApp quiet hours apply or the 24-hour reply window has closed at that time."],
    ["messenger", {}, "It fails without sending if Meta's 24-hour reply window has closed at that time."],
    ["instagram", {}, "It fails without sending if Meta's 24-hour reply window has closed at that time."],
  ])("the %s preview says what can stop it at fire time", async (channel, extra, then) => {
    mem.seed("contacts/c1", { ...ANN, metaUserId: "psid_1" });
    const id = await proposeId({ channel, ...extra });
    expect(row(id).preview).toContainEqual({
      label: "Then",
      value: channel === "whatsapp"
        ? `Fires at that time; the recipient and the number it goes out from are re-checked then, and it won't send if either changed. ${then}`
        : `Fires at that time; the recipient is re-checked then, and it won't send if it changed. ${then}`,
    });
  });

  it("a sub-account timezone that isn't a real zone → the time is shown and labelled as UTC", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, timezone: "Mars/Olympus" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-10T06:00:00.000Z"));
    const id = await proposeId({ sendAt: "2030-01-10T08:00:00.000Z" });
    vi.useRealTimers();
    expect(row(id).preview).toContainEqual({ label: "When", value: "Thu, Jan 10, 8:00 AM (UTC) — 2030-01-10T08:00:00.000Z" });
  });

  it.each([["without a timezone offset", new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 19)], ["in the past", new Date(Date.now() - 60_000).toISOString()], ["under a minute ahead", new Date(Date.now() + 10_000).toISOString()], ["past the 7-day horizon", new Date(Date.now() + 8 * 86_400_000).toISOString()], ["not a date", "tomorrow"]])(
    "a time %s is refused",
    async (_label, sendAt) => {
      const r = await dispatchAgentTool(auth, "schedule_message", { conversationId: "c1", channel: "sms", body: "x", sendAt });
      expect(r).toMatchObject({ ok: false, code: "invalid_args" });
    }
  );

  it("another sub-account's conversation → refused, nothing written", async () => {
    mem.seed("contacts/c2", { ...ANN, subAccountId: "sa2" });
    mem.seed("conversations/c2", { subAccountId: "sa2", agencyId: "ag1", contactId: "c2" });
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, "schedule_message", { conversationId: "c2", channel: "sms", body: "x", sendAt: inAnHour() }))
      .toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
  });
});

describe("approve", () => {
  it("books exactly one message, pinned, as the approver, under a deterministic id", async () => {
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(200);
    const docs = booked();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: `agent_${id}_${row(id).claimId}`, pinnedTo: "+27821111111", createdByUid: "u_admin", status: "pending", channel: "sms",
    });
    expect(publish).toHaveBeenCalledTimes(1);
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it("two concurrent approves → one booking", async () => {
    const id = await proposeId();
    expect((await Promise.all([decide(id, "approve"), decide(id, "approve")])).map((r) => r.status).sort()).toEqual([200, 409]);
    expect(booked()).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("the number changed since the proposal → preview_changed, nothing booked", async () => {
    const id = await proposeId();
    mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(booked()).toEqual([]);
  });

  it("the time passed before approval → refused, nothing booked into the past", async () => {
    const id = await proposeId({ sendAt: new Date(Date.now() + 120_000).toISOString() });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    const res = await decide(id, "approve");
    vi.useRealTimers();
    expect(res.status).toBe(400);
    expect(booked()).toEqual([]);
  });

  it("the time passes between the approve-time check and the booking → refused, nothing booked", async () => {
    const id = await proposeId({ sendAt: new Date(Date.now() + 120_000).toISOString() });
    const later = Date.now() + 5 * 60_000;
    beforeNextTransaction(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(later));
    });
    const res = await decide(id, "approve");
    vi.useRealTimers();
    expect(res.status).not.toBe(202);
    expect(row(id).status).toBe("failed");
    expect(booked()).toEqual([]);
  });

  it("a booking that throws → unsettled, never failed", async () => {
    publish.mockRejectedValueOnce(new Error("QStash timeout"));
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id).status).toBe("unsettled");
  });
});

describe("fire", () => {
  async function approveAndFire(before: () => void) {
    const id = await proposeId();
    await decide(id, "approve");
    const doc = booked()[0]!;
    before();
    return fireScheduledMessage("c1", doc.id as string, (doc.sendAt as { toMillis(): number }).toMillis());
  }

  it("the recipient changed between approval and firing → refused, 0 sends", async () => {
    const r = await approveAndFire(() => mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" }));
    expect(r).toMatchObject({ outcome: "failed", reason: "The recipient changed since this was approved, so it was not sent." });
    expect(booked()[0]).toMatchObject({ status: "failed", failureCode: "recipient_changed" });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it("the sending number changed between approval and firing -> refused sender_changed, 0 sends", async () => {
    const twilio = (fromNumber: string) => ({ enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, twilioConfig: twilio("+27870000001") });
    const r = await approveAndFire(() => {
      expect(booked()[0]).toMatchObject({ pinnedFrom: "+27870000001" });
      mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, twilioConfig: twilio("+27870000002") });
    });
    expect(r).toMatchObject({ outcome: "failed", reason: "The number it would go out from changed since this was approved, so it was not sent." });
    expect(booked()[0]).toMatchObject({ status: "failed", failureCode: "sender_changed" });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it("whatsapp: renaming the sender's label before firing refuses nothing (only the number is pinned)", async () => {
    const sender = (label: string) => ({
      whatsappSenders: [{ id: "s1", label, provider: "cloud", phoneNumber: "+27800000000", isDefault: true }],
      whatsappCloudMeta: { displayPhoneNumber: "+27870000011", phoneNumberId: "pnid1" },
    });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, ...sender("Sales") });
    const id = await proposeId({ channel: "whatsapp" });
    await decide(id, "approve");
    const doc = booked()[0]!;
    expect(doc).toMatchObject({ pinnedFrom: "cloud:+27870000011" });
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, ...sender("Support") });
    const r = await fireScheduledMessage("c1", doc.id as string, (doc.sendAt as { toMillis(): number }).toMillis());
    expect(r).toMatchObject({ outcome: "sent" });
  });

  it("whatsapp: the default moved to a bridge sender at the same number before firing -> sender_changed, 0 sends (W1)", async () => {
    mem.seed("subAccounts/sa1", {
      ...mem.read("subAccounts/sa1")!,
      whatsappSenders: [{ id: "s1", label: "Sales", provider: "cloud", phoneNumber: "+27800000000", isDefault: true }],
      whatsappCloudMeta: { displayPhoneNumber: "+27870000011", phoneNumberId: "pnid1" },
    });
    const id = await proposeId({ channel: "whatsapp" });
    await decide(id, "approve");
    const doc = booked()[0]!;
    mem.seed("subAccounts/sa1", {
      ...mem.read("subAccounts/sa1")!,
      whatsappSenders: [{ id: "s2", label: "Sales", provider: "bridge", phoneNumber: "+27800000000", isDefault: true }],
      whatsappBridgeMeta: { displayPhoneNumber: "+27870000011" },
    });
    const r = await fireScheduledMessage("c1", doc.id as string, (doc.sendAt as { toMillis(): number }).toMillis());
    expect(r).toMatchObject({ outcome: "failed" });
    expect(booked()[0]).toMatchObject({ failureCode: "sender_changed" });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it("a retry of the same booking id with another pinned sender is not the same booking", async () => {
    const { scheduleConversationMessage } = await import("@/lib/server/scheduled-messages/service");
    const book = (pinnedFrom: string) =>
      scheduleConversationMessage({
        request: { contactId: "c1", channel: "sms", body: "Hi", subject: null, inReplyTo: null, references: null, sendAt: new Date(Date.now() + 3_600_000) },
        contact: { ...ANN, id: "c1" } as never,
        actorUid: "u_admin",
        nowMs: Date.now(),
        pinnedTo: "+27821111111",
        pinnedFrom,
        id: "agent_retry",
      });
    expect(await book("+27870000001")).toMatchObject({ ok: true, id: "agent_retry" });
    expect(await book("+27870000001")).toMatchObject({ ok: true, id: "agent_retry" });
    await expect(book("+27870000002")).rejects.toThrow("already exists and is not this booking");
  });

  it("unchanged → it sends, to the pinned number, as the approver", async () => {
    const r = await approveAndFire(() => undefined);
    expect(r).toMatchObject({ outcome: "sent" });
    expect(send.mock.calls[0]![0]).toMatchObject({ contact: { phone: "+27821111111" }, actor: { uid: "u_admin" } });
  });

  it("email consent revoked between approval and firing → the worker refuses, 0 sends", async () => {
    const id = await proposeId({ channel: "email", subject: "Tomorrow", body: "See you" });
    await decide(id, "approve");
    const doc = booked()[0]!;
    mem.seed("contacts/c1", { ...ANN, emailOptedOut: true });
    const r = await fireScheduledMessage("c1", doc.id as string, (doc.sendAt as { toMillis(): number }).toMillis());
    expect(r).toMatchObject({ outcome: "failed", reason: "This contact has opted out of email." });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });
});
