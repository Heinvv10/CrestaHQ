import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { seedPr13, VOICE } from "@/test/pr13-fixtures";

/**
 * The number an agent's SMS, WhatsApp message, WhatsApp template or voice
 * call goes out from is shown ("From") and pinned, as the send resolves it:
 * SMS the Twilio number; WhatsApp the default sender's rail's CONNECTED
 * number (beside the sender's label); a voice call the number its Vapi phone
 * resource was provisioned from. A change after the proposal is a
 * preview_changed; one after the approve's check refuses the send.
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
const cloud = (displayPhoneNumber: string, typed = "+27000000000") => ({
  whatsappSenders: [{ id: "s1", label: "Sales", provider: "cloud", phoneNumber: typed, isDefault: true }],
  whatsappCloudMeta: { displayPhoneNumber, phoneNumberId: "pnid1" },
});
const setSub = (patch: Record<string, unknown>) => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), ...patch });
const voice = (patch: Record<string, unknown>) => mem.seed("subAccounts/sa1/aiAgent/voice", { voice: { ...VOICE, ...patch } });
const fromOf = (id: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === "From")?.value;

async function propose(tool: string, args: Record<string, unknown>) {
  const r = await dispatchAgentTool(auth, tool, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const sms = () => propose("send_message", { conversationId: "c1", channel: "sms", body: "Hi" });

beforeEach(() => {
  send.mockClear();
  createOutboundCall.mockClear();
  seedPr13(mem);
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", territoryId: "global" });
  mem.seed("conversations/c1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", contactName: "Ann", territoryId: "global" });
});

describe("send_message", () => {
  it("sms: shows and pins the Twilio number; a change after propose is preview_changed, nothing sent until re-approved", async () => {
    setSub({ twilioConfig: twilio("+27870000001") });
    const id = await sms();
    expect(fromOf(id)).toBe("+27870000001");
    expect(row(id).pinned).toMatchObject({ from: "+27870000001" });
    setSub({ twilioConfig: twilio("+27870000002") });
    const res = await decide(id, "approve");
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
    expect(fromOf(id)).toBe("+27870000002");
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
    expect((await decide(id, "approve")).status).toBe(200);
    await flushAfterResponse();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sms: the number changed after the approve's check -> failed, nothing sent", async () => {
    setSub({ twilioConfig: twilio("+27870000001") });
    const id = await sms();
    beforeNextTransaction(async () => setSub({ twilioConfig: twilio("+27870000002") }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "The number it would be sent from changed since this was reviewed; nothing was sent." });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it("sms with no dedicated or shared sender says it won't be sent", async () => {
    const id = await sms();
    expect(fromOf(id)).toBe("No sms sender is set up: it will not be sent.");
    expect(row(id).pinned).toMatchObject({ from: null });
  });

  describe("shared SMS sender", () => {
    beforeEach(async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_shared");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
      vi.stubEnv("TWILIO_FROM_NUMBER", "+27870000099");
      (await import("@/lib/agency/policy")).invalidateAgencyPolicyCache("ag1");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("the shared number when the agency allows it", async () => {
      mem.seed("agencies/ag1", { sharedSmsAllowed: true });
      expect(fromOf(await sms())).toBe("+27870000099");
    });

    it("none when the agency disallows shared SMS", async () => {
      mem.seed("agencies/ag1", { sharedSmsAllowed: false });
      expect(fromOf(await sms())).toBe("No sms sender is set up: it will not be sent.");
    });
  });

  it("whatsapp with no usable sender says it won't be sent", async () => {
    setSub({ whatsappSenders: [{ id: "s1", label: "Sales", provider: "cloud", phoneNumber: "+27811111111", isDefault: true, credentialsId: "own" }] });
    const id = await propose("send_message", { conversationId: "c1", channel: "whatsapp", body: "Hi" });
    expect(fromOf(id)).toBe("No whatsapp sender is set up: it will not be sent.");
    expect(row(id).pinned).toMatchObject({ from: null });
  });

  it("whatsapp: the rail's connected number beside the sender's label, not the typed registry number", async () => {
    setSub(cloud("+27870000011", "+27899999999"));
    const id = await propose("send_message", { conversationId: "c1", channel: "whatsapp", body: "Hi" });
    expect(fromOf(id)).toBe("+27870000011 (Sales)");
    expect(row(id).pinned).toMatchObject({ from: "cloud:+27870000011" }); // rail and number, no label
  });

  it("whatsapp: a cloud reconnect to another number after propose is preview_changed, nothing sent", async () => {
    setSub(cloud("+27870000011"));
    const id = await propose("send_message", { conversationId: "c1", channel: "whatsapp", body: "Hi" });
    setSub(cloud("+27870000012"));
    expect(await (await decide(id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it("whatsapp: the default moved to a bridge sender at the same number after the approve's check -> refused, nothing sent (W1)", async () => {
    setSub(cloud("+27870000011"));
    const id = await propose("send_message", { conversationId: "c1", channel: "whatsapp", body: "Hi" });
    beforeNextTransaction(async () =>
      setSub({
        whatsappSenders: [{ id: "s2", label: "Sales", provider: "bridge", phoneNumber: "+27000000000", isDefault: true }],
        whatsappBridgeMeta: { displayPhoneNumber: "+27870000011" },
      })
    );
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id)).toMatchObject({ status: "failed", error: "The number it would be sent from changed since this was reviewed; nothing was sent." });
    await flushAfterResponse();
    expect(send).not.toHaveBeenCalled();
  });

  it("whatsapp: editing only the typed registry number changes nothing", async () => {
    setSub(cloud("+27870000011", "+27811111111"));
    const id = await propose("send_message", { conversationId: "c1", channel: "whatsapp", body: "Hi" });
    setSub(cloud("+27870000011", "+27822222222"));
    expect((await decide(id, "approve")).status).toBe(200);
  });

  it("email has no number row (its From is the mailbox)", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), email: "ann@x.io" });
    const id = await propose("send_message", { conversationId: "c1", channel: "email", subject: "Hi", body: "Hi" });
    expect(row(id).pinned).not.toHaveProperty("from");
  });
});

describe("start_voice_call (twilio-byoc)", () => {
  it("shows and pins the number the Vapi resource was provisioned from; a Twilio number change doesn't move it", async () => {
    setSub({ twilioConfig: twilio("+27870000021") });
    voice({ numberMode: "twilio-byoc", vapiPhoneNumber: "+27870000021" });
    const id = await propose("start_voice_call", { contactId: "c1" });
    expect(fromOf(id)).toBe("+27870000021");
    setSub({ twilioConfig: twilio("+27870000022") });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(createOutboundCall).toHaveBeenCalledTimes(1);
  });

  it("a re-provisioned resource (another number) after propose is preview_changed, no call", async () => {
    voice({ numberMode: "twilio-byoc", vapiPhoneNumber: "+27870000021" });
    const id = await propose("start_voice_call", { contactId: "c1" });
    voice({ numberMode: "twilio-byoc", vapiPhoneNumber: "+27870000031" });
    expect(await (await decide(id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    expect(createOutboundCall).not.toHaveBeenCalled();
  });

  it("the provisioned number changed after the approve's check -> failed, no call (execute re-checks from)", async () => {
    voice({ numberMode: "twilio-byoc", vapiPhoneNumber: "+27870000021" });
    const id = await propose("start_voice_call", { contactId: "c1" });
    beforeNextTransaction(async () => voice({ numberMode: "twilio-byoc", vapiPhoneNumber: "+27870000031" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(createOutboundCall).not.toHaveBeenCalled();
  });

  it("vapi-managed: names the Vapi number resource (its number isn't recorded)", async () => {
    voice({ numberMode: "vapi-managed" });
    const id = await propose("start_voice_call", { contactId: "c1" });
    expect(fromOf(id)).toBe(`the Vapi-managed number ${VOICE.vapiPhoneNumberId} (its number isn't recorded here)`);
  });

  it("legacy config without the provisioned number: names the Vapi resource and pins that", async () => {
    voice({ numberMode: "twilio-byoc", vapiPhoneNumber: undefined });
    const id = await propose("start_voice_call", { contactId: "c1" });
    expect(fromOf(id)).toBe(`the number imported to Vapi as ${VOICE.vapiPhoneNumberId}`);
    expect(row(id).pinned).toMatchObject({ from: `the number imported to Vapi as ${VOICE.vapiPhoneNumberId}` });
  });
});
