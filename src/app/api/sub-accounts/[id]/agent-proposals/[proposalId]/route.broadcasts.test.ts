import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { seedPr13, TEMPLATE } from "@/test/pr13-fixtures";

/**
 * create_broadcast (PR13) through the real dispatch and decide route and the
 * send route's own checks: an outbound proposal with the exact template, the
 * audience and how many it matches; approve re-resolves the audience, refuses
 * growth, and starts a broadcast that carries what was approved.
 */

const publishCallback = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ messageId: "q" })));
vi.mock("@/lib/automations/qstash", async (orig) => ({ ...((await orig()) as object), qstashIsConfigured: () => true, publishCallback }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { templateFingerprint } = await import("@/lib/broadcasts/approved");

const ALL = { templateId: "tpl_email", audienceFilter: { kind: "all" } };
const contact = (id: string, patch: Record<string, unknown> = {}) =>
  mem.seed(`contacts/${id}`, { subAccountId: "sa1", agencyId: "ag1", name: id, email: `${id}@x.io`, tags: [], ...patch });
const call = (args: Record<string, unknown>) => dispatchAgentTool(auth, "create_broadcast", args);
async function proposeId(args: Record<string, unknown> = ALL): Promise<string> {
  const r = await call(args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;

beforeEach(() => {
  publishCallback.mockClear();
  seedPr13(mem);
  contact("c1", { tags: ["vip"] });
  contact("c2");
});

describe("create_broadcast", () => {
  it("an outbound proposal with the exact template and the matched count; approve starts a broadcast carrying them", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "To")).toBe("every contact: 2 contact(s) now, less those opted out or without an email");
    expect(rowOf(id, "Subject")).toBe("Winter special");
    expect(row(id).preview).toContainEqual({ label: "Message", value: TEMPLATE.body, multiline: true });
    expect(row(id).pinned).toMatchObject({ templateId: "tpl_email", audienceCount: 2, templateFingerprint: templateFingerprint(TEMPLATE as never) });
    expect(mem.list("broadcasts")).toEqual([]);
    expect((await decide(id, "approve")).status).toBe(200);
    const [b] = mem.list("broadcasts");
    expect(b).toMatchObject({ status: "queued", templateId: "tpl_email", audienceFilter: { kind: "all" }, approved: { audienceCap: 2, templateFingerprint: templateFingerprint(TEMPLATE as never) } });
    // Anchored at the proposal's own Firestore server time.
    expect((b.approved as { at: unknown }).at).toEqual(row(id).createdServerAt);
    expect(publishCallback).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/api/broadcasts/email/fanout" }));
  });

  it("the preview says agent edits after approval are skipped; a contact the agent tags afterwards counts as edited", async () => {
    const id = await proposeId({ ...ALL, audienceFilter: { kind: "tag", tag: "vip" } });
    expect(rowOf(id, "At send")).toBe("The audience is re-read at send; contacts an API agent edits after approval are skipped.");
    expect((await decide(id, "approve")).status).toBe(200);
    const [b] = mem.list("broadcasts");
    expect(await dispatchAgentTool(auth, "add_tags", { contactId: "c2", tags: ["vip"] })).toMatchObject({ ok: true });
    const { editedByAgentSinceApproval } = await import("@/lib/broadcasts/approved");
    expect(editedByAgentSinceApproval(b as never, mem.read("contacts/c2")!)).toBe(true);
    expect(editedByAgentSinceApproval(b as never, mem.read("contacts/c1")!)).toBe(false);
  });

  it("an agent edit between the proposal and its approval counts as edited (the approver never saw it)", async () => {
    // A template without contact merge tags shows no agent-set values, so only the skip guards this.
    mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: "Winter sale. {{unsubscribeLink}}", subject: "Sale" });
    const id = await proposeId();
    await new Promise((r) => setTimeout(r, 5));
    expect(await dispatchAgentTool(auth, "add_tags", { contactId: "c2", tags: ["vip"] })).toMatchObject({ ok: true });
    expect((await decide(id, "approve")).status).toBe(200);
    const [b] = mem.list("broadcasts");
    const { editedByAgentSinceApproval } = await import("@/lib/broadcasts/approved");
    expect(editedByAgentSinceApproval(b as never, mem.read("contacts/c2")!)).toBe(true);
    expect(editedByAgentSinceApproval(b as never, mem.read("contacts/c1")!)).toBe(false);
  });

  it("a contact whose custom field the agent edits after approval counts as edited too", async () => {
    const id = await proposeId();
    expect((await decide(id, "approve")).status).toBe(200);
    const [b] = mem.list("broadcasts");
    expect(await dispatchAgentTool(auth, "update_contact", { contactId: "c1", customFields: { plan: "Evil" } })).toMatchObject({ ok: true });
    const { editedByAgentSinceApproval } = await import("@/lib/broadcasts/approved");
    expect(editedByAgentSinceApproval(b as never, mem.read("contacts/c1")!)).toBe(true);
  });

  it("one broadcast per approval: the same claim again is a duplicate, said so; a new approval sends", async () => {
    const id = await proposeId();
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const cap = getCapability("create_broadcast")!;
    const ctx = (claimId: string) => ({ uid: "u1", email: "a@x.io", displayName: "A", agencyId: "ag1", subAccountId: "sa1", approved: { pinned: row(id).pinned as Record<string, unknown>, proposalId: id, claimId } });
    expect(await cap.execute(ctx("claim1"), ALL)).toMatchObject({ resultText: expect.stringContaining("Started the broadcast") });
    expect(await cap.execute(ctx("claim1"), ALL)).toMatchObject({ resultText: expect.stringContaining("already started") });
    expect(await cap.execute(ctx("claim2"), ALL)).toMatchObject({ resultText: expect.stringContaining("Started the broadcast") });
    expect(mem.list("broadcasts")).toHaveLength(2);
  });

  it("an agent edit between the proposal and its approval, with contact merge tags -> the values changed -> preview_changed", async () => {
    const id = await proposeId();
    contact("c2", { lastAgentEditAt: new Date(), name: "Evil" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_changed" });
  });

  describe("agent-set values", () => {
    const NOTE = { ...TEMPLATE, body: "Hi {{contact.firstName}}. {{contact.customFields.note}}\nUnsubscribe: {{unsubscribeLink}}" };

    it("a value an agent set BEFORE the proposal is shown to the approver, exactly", async () => {
      mem.seed("message_templates/tpl_email", NOTE);
      // As an agent's update_contact leaves it: the value and the agent's edit stamp.
      contact("c1", { customFields: { note: "Claim your refund at evil.example" }, lastAgentEditAt: new Date(Date.now() - 60_000), lastAgentEditKey: "abcd1234" });
      const id = await proposeId();
      expect(rowOf(id, "Agent-set values")).toBe('c1: contact.customFields.note = "Claim your refund at evil.example"; contact.firstName = "c1"');
    });

    it("no agent-set values: the row says none", async () => {
      expect(rowOf(await proposeId(), "Agent-set values")).toBe("none (no contact in the audience has values an API agent set)");
    });

    it("a template with no contact merge tags: no row, whatever agents set", async () => {
      mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: "Winter sale. {{unsubscribeLink}}", subject: "Sale" });
      contact("c1", { lastAgentEditAt: new Date() });
      expect(rowOf(await proposeId(), "Agent-set values")).toBeUndefined();
    });

    it("an agent-set value with a hidden character -> refused", async () => {
      mem.seed("message_templates/tpl_email", NOTE);
      contact("c1", { customFields: { note: "Pay\u200bhere" }, lastAgentEditAt: new Date() });
      expect(await call(ALL)).toMatchObject({ ok: false, message: "A value an API agent set has characters that can't be shown safely; send this broadcast from the app." });
    });

    it("more than 50 agent-set contacts -> refused", async () => {
      for (let i = 0; i < 51; i++) contact(`ag${String(i).padStart(2, "0")}`, { lastAgentEditAt: new Date() });
      expect(await call(ALL)).toMatchObject({ ok: false, message: "Too many contacts have values an API agent set to review here; send this broadcast from the app." });
    });

    it("an agent-set value changed after the approver's preview check -> failed, nothing started", async () => {
      mem.seed("message_templates/tpl_email", NOTE);
      contact("c1", { lastAgentEditAt: new Date(Date.now() - 60_000), customFields: { note: "Hello" } });
      const id = await proposeId();
      beforeNextTransaction(async () => contact("c1", { lastAgentEditAt: new Date(Date.now() - 60_000), customFields: { note: "Pay here instead" } }));
      expect((await decide(id, "approve")).status).toBe(422);
      expect(mem.list("broadcasts")).toEqual([]);
    });
  });

  it("a proposal from before createdServerAt existed is anchored at its createdAt; an unreadable one is refused", async () => {
    const id = await proposeId();
    const { createdServerAt: _s, ...legacy } = row(id);
    mem.seed(`agentProposals/${id}`, legacy);
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const cap = getCapability("create_broadcast")!;
    const ctx = (proposalId: string) => ({ uid: "u1", email: "a@x.io", displayName: "A", agencyId: "ag1", subAccountId: "sa1", approved: { pinned: row(id).pinned as Record<string, unknown>, proposalId, claimId: proposalId } });
    await cap.execute(ctx(id), ALL);
    expect((mem.list("broadcasts")[0]!.approved as { at: unknown }).at).toEqual(legacy.createdAt);
    await expect(cap.execute(ctx("p_missing"), ALL)).rejects.toThrow("The proposal couldn't be read; nothing was sent.");
  });

  it("a tag audience counts only its contacts", async () => {
    const id = await proposeId({ ...ALL, audienceFilter: { kind: "tag", tag: "vip" } });
    expect(rowOf(id, "To")).toBe('contacts tagged "vip": 1 contact(s) now, less those opted out or without an email');
  });

  it("the audience grew after the approver's preview check -> failed, nothing started", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => contact("c3"));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The audience grew to 3 contacts since 2 were approved; nothing was sent. Propose it again.");
    expect(mem.list("broadcasts")).toEqual([]);
  });

  it("the template edited after the approver's preview check -> failed, nothing started", async () => {
    const id = await proposeId();
    beforeNextTransaction(async () => mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: `${TEMPLATE.body}\nNew line` }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.list("broadcasts")).toEqual([]);
  });

  it.each([
    ["broadcasts off for the sub-account", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, broadcastsEnabledByAgency: false }), expect.stringContaining("Broadcasts are disabled")],
    ["a template without an unsubscribe link", () => mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: "Hi" }), "Email body must include {{unsubscribeLink}} somewhere."],
    ["a template with a hidden character", () => mem.seed("message_templates/tpl_email", { ...TEMPLATE, body: `${TEMPLATE.body}\u200b` }), "The template has characters or spacing that can't be shown exactly as sent."],
    ["an empty audience", () => (contact("c1", { subAccountId: "sa2" }), contact("c2", { subAccountId: "sa2" })), "Audience is empty \u2014 no contacts match this filter."],
  ])("%s -> refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call(ALL)).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("a malformed audience / a path template id -> invalid args", async () => {
    expect(await call({ ...ALL, audienceFilter: { kind: "tag" } })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await call({ ...ALL, templateId: "t/x/y" })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});
