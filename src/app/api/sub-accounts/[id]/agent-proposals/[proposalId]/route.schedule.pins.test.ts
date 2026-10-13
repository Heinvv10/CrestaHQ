import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { NextResponse } from "next/server";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * schedule_message's pins on every kind of address, its own approve-time and
 * propose-time checks (not only send_message's), and the booking's
 * idempotency: a retry of the same booking books once; anything else found
 * under the id, or any other create error, is never reported as booked.
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
const { scheduleConversationMessage } = await import("@/lib/server/scheduled-messages/service");

const ANN = { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", email: "ann@x.io", metaUserId: "psid_1", territoryId: "global" };
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

describe.each([
  ["whatsapp", { phone: "+27829999999" }, "+27821111111"],
  ["messenger", { metaUserId: "psid_2" }, "psid_1"],
])("%s: the pinned address", (channel, changed, pinned) => {
  it("changed before approval → preview_changed, nothing booked", async () => {
    const id = await proposeId({ channel });
    expect(row(id).pinned).toMatchObject({ channel, to: pinned });
    mem.seed("contacts/c1", { ...ANN, ...changed });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(booked()).toEqual([]);
  });

  it("changed between approval and firing → failed, recipient_changed, 0 sends", async () => {
    const id = await proposeId({ channel });
    expect((await decide(id, "approve")).status).toBe(200);
    const doc = booked()[0]!;
    expect(doc).toMatchObject({ pinnedTo: pinned });
    mem.seed("contacts/c1", { ...ANN, ...changed });
    const r = await fireScheduledMessage("c1", doc.id as string, (doc.sendAt as { toMillis(): number }).toMillis());
    expect(r).toMatchObject({ outcome: "failed" });
    expect(booked()[0]).toMatchObject({ status: "failed", failureCode: "recipient_changed" });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("schedule_message's own consent and recipient checks", () => {
  it("an sms opt-out refuses the proposal", async () => {
    mem.seed("contacts/c1", { ...ANN, smsOptedOut: true });
    expect(await dispatchAgentTool(auth, "schedule_message", { conversationId: "c1", channel: "sms", body: "x", sendAt: inAnHour() }))
      .toMatchObject({ ok: false, message: "This contact has opted out of SMS (replied STOP)." });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("an sms opt-out after the proposal: the approver sees it, and approving anyway books nothing", async () => {
    const id = await proposeId();
    mem.seed("contacts/c1", { ...ANN, smsOptedOut: true });
    expect((await decide(id, "approve")).status).toBe(409);
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "This contact has opted out of SMS (replied STOP)." });
    expect(booked()).toEqual([]);
  });

  it("the number changed between the approve-time re-check and the booking → failed, nothing booked", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "The recipient changed since this was reviewed; nothing was sent." });
    expect(booked()).toEqual([]);
  });
});

describe("booking under a caller's id", () => {
  const input = () => ({
    request: { contactId: "c1", channel: "sms" as const, body: "x", subject: null, inReplyTo: null, references: null, sendAt: new Date(Date.now() + 3_600_000) },
    contact: { id: "c1", ...ANN } as never, actorUid: "u_admin", nowMs: Date.now(), pinnedTo: "+27821111111", id: "agent_p1_k1",
  });

  it("a retry of the same booking books once", async () => {
    expect(await scheduleConversationMessage(input())).toEqual({ ok: true, id: "agent_p1_k1" });
    expect(await scheduleConversationMessage(input())).toEqual({ ok: true, id: "agent_p1_k1" });
    expect(booked()).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different body", { body: "y" }],
    ["a different channel", { channel: "whatsapp" }],
    ["a different pin", { pinnedTo: "+27829999999" }],
    ["a failed booking", { status: "failed" }],
    ["a cancelled booking", { status: "cancelled" }],
  ])("the id already holds %s → throws, never booked", async (_label, patch) => {
    await scheduleConversationMessage(input());
    mem.seed("contacts/c1/scheduledMessages/agent_p1_k1", { ...mem.read("contacts/c1/scheduledMessages/agent_p1_k1")!, ...patch });
    await expect(scheduleConversationMessage(input())).rejects.toThrow("already exists and is not this booking");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("a create error other than ALREADY_EXISTS → the proposal is unsettled, never booked", async () => {
    const collection = mem.db.collection.bind(mem.db);
    vi.spyOn(mem.db, "collection").mockImplementation(((path: string) => {
      const col = collection(path);
      if (!path.endsWith("/scheduledMessages")) return col;
      return { ...col, doc: (id?: string) => ({ ...col.doc(id!), create: async () => { throw Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }); } }) };
    }) as typeof mem.db.collection);
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(202);
    expect(row(id).status).toBe("unsettled");
    expect(publish).not.toHaveBeenCalled();
  });
});
