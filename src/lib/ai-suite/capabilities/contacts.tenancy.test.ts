import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * PR7 contact capabilities on the agent surface, through the real
 * dispatchAgentTool over an in-memory Firestore: a contact id from another
 * sub-account is refused before anything is written, update_contact keeps
 * to its allowlist, and phone / email changes become proposals.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

await setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");
const { buildAgentContext } = await import("@/lib/api/agent-context");

const ANN = {
  subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", email: "ann@x.io", phone: "+27821111111",
  tags: ["lead"], customFields: {}, territoryId: "global",
  emailOptedOut: false, smsOptedOut: false, whatsappOptedOut: false, source: "form", attribution: { utmSource: "g" },
};
beforeEach(() => {
  mem.seed("contacts/c1", ANN);
  mem.seed("contacts/c2", { ...ANN, subAccountId: "sa2", name: "Bob Other", email: "bob@other.io" });
});

describe("contacts.tenancy: an sa2 contact id from an sa1 key", () => {
  const CASES: Array<[string, Record<string, unknown>]> = [
    ["get_contact", { contactId: "c2" }],
    ["update_contact", { contactId: "c2", name: "Hijacked" }],
    ["add_tags", { contactId: "c2", tags: ["x"] }],
    ["remove_tags", { contactId: "c2", tags: ["lead"] }],
    ["update_contact_channels", { contactId: "c2", phone: "+27829999999" }],
    ["delete_contact", { contactId: "c2" }],
  ];

  it.each(CASES)("%s → a user error naming no data, and 0 writes", async (name, args) => {
    const before = JSON.stringify(mem.all());
    const r = await dispatchAgentTool(auth, name, args);
    expect(r).toMatchObject({ ok: false, httpStatus: 400, message: "That contact isn't in this workspace." });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each(CASES)("%s execute (the approve path too) throws CapabilityUserError on it", async (name, args) => {
    const ctx = { ...buildAgentContext(auth), approved: { pinned: { ...args } } };
    const validated = getCapability(name)!.validate(args);
    if (!validated.ok) throw new Error(validated.error);
    await expect(getCapability(name)!.execute(ctx, validated.args)).rejects.toBeInstanceOf(CapabilityUserError);
    expect(mem.read("contacts/c2")).toMatchObject({ name: "Bob Other", phone: ANN.phone });
  });
});

describe("the services re-check the sub-account themselves", () => {
  it("updateContactServerSide with subAccountId: another sub-account's contact reads as missing, unchanged", async () => {
    const { updateContactServerSide } = await import("@/lib/server/contacts-service");
    expect(await updateContactServerSide({ contactId: "c2", patch: { name: "X" }, subAccountId: "sa1" })).toBeNull();
    expect(mem.read("contacts/c2")!.name).toBe("Bob Other");
  });

  it("deleteContactServerSide with subAccountId: another sub-account's contact is not_found, not deleted", async () => {
    const { deleteContactServerSide } = await import("@/lib/server/contact-delete");
    expect(await deleteContactServerSide({ contactId: "c2", subAccountId: "sa1" })).toEqual({ status: "not_found" });
    expect(mem.read("contacts/c2")).toBeDefined();
  });
});

describe("update_contact", () => {
  it("strips consent flags, source and attribution", async () => {
    const r = await dispatchAgentTool(auth, "update_contact", {
      contactId: "c1", name: "Ann B",
      whatsappOptedOut: true, emailOptedOut: true, smsOptedOut: true, source: "agent", attribution: { utmSource: "x" },
    });
    expect(r).toMatchObject({ ok: true });
    expect(mem.read("contacts/c1")).toMatchObject({
      name: "Ann B", whatsappOptedOut: false, emailOptedOut: false, smsOptedOut: false, source: "form", attribution: { utmSource: "g" },
    });
  });

  it("strips phone and email, says so, and the channel change goes through update_contact_channels as a proposal", async () => {
    const r = await dispatchAgentTool(auth, "update_contact", {
      contactId: "c1", company: "Acme", phone: "+27829999999", email: "new@x.io",
    });
    expect(r).toMatchObject({ ok: true, resultText: expect.stringContaining("update_contact_channels") });
    expect(mem.read("contacts/c1")).toMatchObject({ company: "Acme", phone: ANN.phone, email: ANN.email });
    expect(mem.list("agentProposals")).toEqual([]);

    const q = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", phone: "+27829999999" });
    expect(q).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(mem.list("agentProposals")).toMatchObject([
      { capability: "update_contact_channels", approval: "channel_change", contactId: "c1", pinned: { contactId: "c1", phone: "+27829999999" } },
    ]);
    expect(mem.read("contacts/c1")!.phone).toBe(ANN.phone);
  });

  it("only phone / email → nothing to change, refused", async () => {
    const r = await dispatchAgentTool(auth, "update_contact", { contactId: "c1", phone: "+27829999999" });
    expect(r).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("merges custom fields into the existing ones, validated against the live definitions", async () => {
    mem.seed("subAccounts/sa1/customFields/f1", { entity: "contact", key: "plan", label: "Plan", type: "text" });
    mem.seed("contacts/c1", { ...ANN, customFields: { plan: "old" } });
    expect(await dispatchAgentTool(auth, "update_contact", { contactId: "c1", customFields: { plan: "Fibre 100", junk: 1 } }))
      .toMatchObject({ ok: true });
    expect(mem.read("contacts/c1")!.customFields).toEqual({ plan: "Fibre 100" });
  });
});

describe("update_contact_channels execute", () => {
  it("writes the values the approver reviewed (ctx.approved.pinned), not the args", async () => {
    const cap = getCapability("update_contact_channels")!;
    const ctx = { ...buildAgentContext(auth), approved: { pinned: { contactId: "c1", phone: "+27825555555" } } };
    await cap.execute(ctx, { contactId: "c1", phone: "+27829999999" });
    expect(mem.read("contacts/c1")!.phone).toBe("+27825555555");
  });

  it("refuses when the pinned contact is not the args' contact", async () => {
    const cap = getCapability("update_contact_channels")!;
    const ctx = { ...buildAgentContext(auth), approved: { pinned: { contactId: "c9", phone: "+27825555555" } } };
    await expect(cap.execute(ctx, { contactId: "c1", phone: "+27825555555" })).rejects.toBeInstanceOf(CapabilityUserError);
    expect(mem.read("contacts/c1")!.phone).toBe(ANN.phone);
  });
});

describe("tags", () => {
  it("add_tags keeps the existing tags; remove_tags drops only the named ones", async () => {
    await dispatchAgentTool(auth, "add_tags", { contactId: "c1", tags: ["vip", "lead"] });
    expect(mem.read("contacts/c1")!.tags).toEqual(["lead", "vip"]);
    await dispatchAgentTool(auth, "remove_tags", { contactId: "c1", tags: ["lead", "absent"] });
    expect(mem.read("contacts/c1")!.tags).toEqual(["vip"]);
  });
});

describe("get_contact", () => {
  it("reads the contact, including its opt-outs", async () => {
    mem.seed("contacts/c1", { ...ANN, smsOptedOut: true });
    const r = await dispatchAgentTool(auth, "get_contact", { contactId: "c1" });
    expect(r).toMatchObject({ ok: true, resultText: expect.stringContaining("Opted out of: sms") });
  });
});
