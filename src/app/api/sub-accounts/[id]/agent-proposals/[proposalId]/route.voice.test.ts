import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { seedPr13, VOICE } from "@/test/pr13-fixtures";

/**
 * start_voice_call (PR13) through the real dispatch, decide route and the
 * call route's own gates and compliance check: an outbound proposal showing
 * the number, the assistant and its first words, pinned; approve dials
 * exactly that, and nothing when compliance blocks or anything changed.
 */

const createOutboundCall = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ callId: "call1", controlUrl: null })));
vi.mock("@/lib/comms/voice/vapi", async (orig) => ({ ...((await orig()) as object), createOutboundCall }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann Smith", phone: "+27821111111", territoryId: "global" };
const call = (args: Record<string, unknown> = { contactId: "c1" }) => dispatchAgentTool(auth, "start_voice_call", args);
async function proposeId(): Promise<string> {
  const r = await call();
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const voice = (patch: Record<string, unknown>) => mem.seed("subAccounts/sa1/aiAgent/voice", { voice: { ...VOICE, ...patch } });

beforeEach(() => {
  createOutboundCall.mockClear();
  seedPr13(mem);
  mem.seed("contacts/c1", ANN);
});

describe("start_voice_call", () => {
  it("an outbound proposal with the number, assistant and first words; approve dials exactly that", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "Call")).toBe("Ann Smith (\u20261111)");
    expect(rowOf(id, "Assistant")).toContain("asst1");
    expect(row(id).preview).toContainEqual({ label: "First words", value: VOICE.outboundFirstMessage, multiline: true });
    expect(row(id).preview).toContainEqual({ label: "Script (what the AI is told)", value: VOICE.outboundSystemPrompt, multiline: true });
    expect(row(id).pinned).toEqual({
      contactId: "c1", number: "+27821111111", assistantId: "asst1", phoneNumberId: "pn1", firstMessage: VOICE.outboundFirstMessage, promptFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(createOutboundCall).not.toHaveBeenCalled();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(createOutboundCall).toHaveBeenCalledWith(expect.objectContaining({ assistantId: "asst1", phoneNumberId: "pn1", customerNumber: "+27821111111", contactId: "c1", firstMessage: VOICE.outboundFirstMessage }));
    expect(mem.read("subAccounts/sa1/voiceCalls/call1")).toMatchObject({ direction: "outbound", initiatedByUid: "u_admin", consentAck: true });
  });

  it.each([
    ["a voice opt-out", () => mem.seed("contacts/c1", { ...ANN, voiceOptedOut: true }), "This contact has opted out of voice calls."],
    ["another sub-account's contact", () => mem.seed("contacts/c1", { ...ANN, subAccountId: "sa2" }), "That contact isn't in this workspace."],
    ["no valid number", () => mem.seed("contacts/c1", { ...ANN, phone: "123" }), "This contact has no valid phone number."],
    ["outbound calling off", () => voice({ outboundEnabled: false }), "Outbound calling isn't enabled in the Voice settings."],
    ["the agency gate off", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, outboundVoiceEnabledByAgency: false }), expect.stringContaining("Outbound calling is disabled")],
    ["an opening line with a hidden character", () => voice({ outboundFirstMessage: "Hi\u200b there" }), "The opening line has characters or spacing that can't be shown exactly."],
    ["no persona", () => mem.seed("subAccounts/sa1/aiAgent/profile", { timezone: "UTC", systemPrompt: " " }), "The Voice channel has no persona configured."],
    ["a script with a hidden character", () => voice({ outboundSystemPrompt: "Call\u200b them" }), "The call's persona has characters or spacing that can't be shown exactly."],
  ])("%s -> refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call()).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it.each([
    ["the opening line", () => voice({ outboundFirstMessage: "Something else" })],
    ["the number", () => mem.seed("contacts/c1", { ...ANN, phone: "+27829999999" })],
    ["the outbound script", () => voice({ outboundSystemPrompt: "You are selling a new plan." })],
    ["the shared knowledge the script is built on", () => mem.seed("subAccounts/sa1/aiAgent/profile", { ...mem.read("subAccounts/sa1/aiAgent/profile")!, websiteKb: { summary: "New facts" } })],
  ])("%s changed after the approver's preview check -> failed, no call", async (_label, change) => {
    const id = await proposeId();
    beforeNextTransaction(async () => change());
    expect((await decide(id, "approve")).status).toBe(422);
    expect(createOutboundCall).not.toHaveBeenCalled();
  });

  it("the daily call limit reached by dial time -> the call's own compliance check refuses, no call", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => voice({ outboundDailyCap: 0 }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The call wasn't placed: Daily outbound call limit reached for this workspace.");
    expect(createOutboundCall).not.toHaveBeenCalled();
  });

  it("the provider errors -> unsettled (it may have rung), never failed", async () => {
    createOutboundCall.mockRejectedValueOnce(new Error("vapi down"));
    const id = await proposeId();
    await decide(id, "approve");
    expect(row(id).status).toBe("unsettled");
  });
});
