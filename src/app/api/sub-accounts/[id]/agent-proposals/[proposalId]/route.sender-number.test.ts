import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { seedPr13 } from "@/test/pr13-fixtures";

/**
 * The number an agent's SMS, WhatsApp message, WhatsApp template or voice
 * call goes out from is shown ("From") and pinned: the default sender
 * changing after the proposal makes the approve a preview_changed, and
 * nothing goes out until the approver has seen the new number.
 */

const send = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, messageId: "SM1", response: {} })));
vi.mock("@/lib/server/conversation-send", async (orig) => ({ ...((await orig()) as object), sendConversationMessage: send }));
const createOutboundCall = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ callId: "call1", controlUrl: null })));
vi.mock("@/lib/comms/voice/vapi", async (orig) => ({ ...((await orig()) as object), createOutboundCall }));
vi.mock("@/lib/reviews/review-ask", async (orig) => ({ ...((await orig()) as object), logInboxReviewAsk: async () => undefined }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) => (await import("@/test/agent-proposals-harness")).replayMock(orig));

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const twilio = (fromNumber: string) => ({ enabled: true, accountSid: "AC1", authTokenSet: true, fromNumber });
const waSender = (phoneNumber: string) => [{ id: "s1", label: "Sales", provider: "cloud", phoneNumber, isDefault: true }];
const setSub = (patch: Record<string, unknown>) => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), ...patch });
const fromOf = (id: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === "From")?.value;

async function propose(tool: string, args: Record<string, unknown>) {
  const r = await dispatchAgentTool(auth, tool, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}

beforeEach(() => {
  send.mockClear();
  createOutboundCall.mockClear();
  seedPr13(mem);
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", territoryId: "global" });
  mem.seed("conversations/c1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann", territoryId: "global" });
});

describe("send_message", () => {
  it("sms: shows and pins the sub-account's Twilio number; a change after propose is preview_changed, nothing sent", async () => {
    setSub({ twilioConfig: twilio("+27870000001") });
    const id = await propose("send_message", { conversationId: "c1", channel: "sms", body: "Hi" });
    expect(fromOf(id)).toBe("+27870000001");
    expect(row(id).pinned).toMatchObject({ from: "+27870000001" });
    setSub({ twilioConfig: twilio("+27870000002") });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(fromOf(id)).toBe("+27870000002");
    expect(send).not.toHaveBeenCalled();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sms with no dedicated or shared sender says it won't be sent", async () => {
    const id = await propose("send_message", { conversationId: "c1", channel: "sms", body: "Hi" });
    expect(fromOf(id)).toBe("No sms sender is set up: it will not be sent.");
    expect(row(id).pinned).toMatchObject({ from: null });
  });

  it("whatsapp: shows and pins the default sender; a new default after propose is preview_changed", async () => {
    setSub({ whatsappSenders: waSender("+27870000011") });
    const id = await propose("send_message", { conversationId: "c1", channel: "whatsapp", body: "Hi" });
    expect(fromOf(id)).toBe("+27870000011 (Sales)");
    setSub({ whatsappSenders: waSender("+27870000012") });
    expect(await (await decide(id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("email has no number row (its From is the mailbox)", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), email: "ann@x.io" });
    const id = await propose("send_message", { conversationId: "c1", channel: "email", subject: "Hi", body: "Hi" });
    expect(row(id).pinned).not.toHaveProperty("from");
  });
});

describe("start_voice_call", () => {
  it("twilio-byoc: shows and pins the Twilio number it rings from; a change is preview_changed, no call", async () => {
    setSub({ twilioConfig: twilio("+27870000021") });
    const id = await propose("start_voice_call", { contactId: "c1" });
    expect(fromOf(id)).toBe("+27870000021");
    setSub({ twilioConfig: twilio("+27870000022") });
    expect(await (await decide(id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    expect(createOutboundCall).not.toHaveBeenCalled();
  });
});
