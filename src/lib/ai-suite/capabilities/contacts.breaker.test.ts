import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * Breaker repros from PR #269: args smuggled past update_contact's allowlist,
 * a contactId that is really a subcollection path, and channel values the
 * approver sees differently from what is stored.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
await setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const ANN = {
  subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", email: "ann@x.io", phone: "+27821111111",
  tags: ["lead"], customFields: {}, territoryId: "global",
  emailOptedOut: false, smsOptedOut: false, whatsappOptedOut: true, source: "form", attribution: { utmSource: "g" },
};
const SCHED = { subAccountId: "sa1", agencyId: "ag1", status: "pending", channel: "whatsapp", body: "See you at 3", createdByUid: "u1" };
const WAMSG = { subAccountId: "sa1", agencyId: "ag1", direction: "inbound", body: "customer said X" };

beforeEach(() => {
  mem.seed("contacts/c1", ANN);
  mem.seed("contacts/c1/scheduledMessages/s1", SCHED);
  mem.seed("contacts/c1/whatsappMessages/m1", WAMSG);
  mem.seed("contacts/c2", { ...ANN, subAccountId: "sa2", name: "Bob" });
});

describe("rules a/b smuggling", () => {
  it.each([
    [{ customFields: { whatsappOptedOut: false, "attribution.source": "x", __proto__: { phone: "+1" } } }],
    [{ "customFields.whatsappOptedOut": false, name: "A" }],
    [{ "attribution.source": "x", name: "A" }],
    [{ whatsappOptedOut: false, name: "A" }],
    [{ tags: [{ phone: "+1" }, "ok"], name: "A" }],
    [{ name: ["x"], company: { whatsappOptedOut: false }, address: "a" }],
  ])("%j leaves consent/source/attribution/phone/email untouched", async (extra) => {
    await dispatchAgentTool(auth, "update_contact", { contactId: "c1", ...(extra as object) });
    const c = mem.read("contacts/c1")!;
    expect(c).toMatchObject({ whatsappOptedOut: true, source: "form", attribution: { utmSource: "g" }, phone: ANN.phone, email: ANN.email });
    expect(Object.keys(c).filter((k) => k.includes("."))).toEqual([]);
  });
  it("add_tags extra args ignored", async () => {
    await dispatchAgentTool(auth, "add_tags", { contactId: "c1", tags: ["x"], whatsappOptedOut: false, phone: "+1555" });
    expect(mem.read("contacts/c1")).toMatchObject({ whatsappOptedOut: true, phone: ANN.phone });
  });
});

describe("contactId path segments", () => {
  it("update_contact with a subcollection path is refused (not written into a scheduled message)", async () => {
    const r = await dispatchAgentTool(auth, "update_contact", { contactId: "c1/scheduledMessages/s1", name: "X", tags: ["t"] });
    expect(mem.read("contacts/c1/scheduledMessages/s1")).toEqual(SCHED);
    expect(r).toMatchObject({ ok: false });
  });
  it("get_contact with a subcollection path is refused", async () => {
    const r = await dispatchAgentTool(auth, "get_contact", { contactId: "c1/whatsappMessages/m1" });
    expect(r).toMatchObject({ ok: false });
  });
  it("delete_contact with a message path is refused at propose (else approve deletes a single message)", async () => {
    const r = await dispatchAgentTool(auth, "delete_contact", { contactId: "c1/whatsappMessages/m1" });
    if ("proposal" in r) {
      const preview = row(r.proposal.id).preview;
      const res = await decide(r.proposal.id, "approve");
      expect({ preview, status: res.status, msgGone: mem.read("contacts/c1/whatsappMessages/m1") === undefined }).toEqual("refused at propose");
    }
    expect(r).toMatchObject({ ok: false });
  });
});

describe("rule c normalisation: stored value === value the approver saw", () => {
  it.each([
    ["+27 82 999 9999"], ["+0027829999999"], ["+２７８２９９９９９９９"], ["+٢٧٨٢٩٩٩٩٩٩٩"], ["+27829999999\u200b"], ["+27 (82) 999-9999 ext 5"],
  ])("phone %j", async (phone) => {
    const r = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", phone });
    if (!("proposal" in r)) return; // refused: fine
    const shown = (row(r.proposal.id).preview as Array<{ label: string; value: string }>).find((x) => x.label === "Phone")!.value.split(" → ")[1];
    expect((await decide(r.proposal.id, "approve")).status).toBe(200);
    expect(mem.read("contacts/c1")!.phone).toBe(shown);
    expect(shown).toMatch(/^\+[1-9]\d{6,14}$/);
  });
  it.each([["  New@X.IO  "], ["new@x.io\u200b"], ["\u202eoi.x@wen"], ["new@x.io\u0000"]])("email %j", async (email) => {
    const r = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", email });
    if (!("proposal" in r)) return;
    const shown = (row(r.proposal.id).preview as Array<{ label: string; value: string }>).find((x) => x.label === "Email")!.value.split(" → ")[1];
    expect((await decide(r.proposal.id, "approve")).status).toBe(200);
    expect(mem.read("contacts/c1")!.email).toBe(shown);
    expect(shown, "invisible/control chars reach the approver's screen").toMatch(/^[\x21-\x7e]+$/);
  });
  it("a second proposal cannot ride the first's approval", async () => {
    const a = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", phone: "+27825555555" });
    const b = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", phone: "+27826666666" });
    if (!("proposal" in a) || !("proposal" in b)) throw new Error("no proposals");
    expect((await decide(a.proposal.id, "approve")).status).toBe(200);
    expect(mem.read("contacts/c1")!.phone).toBe("+27825555555");
    expect((await decide(b.proposal.id, "approve")).status).toBe(409);
    expect(mem.read("contacts/c1")!.phone).toBe("+27825555555");
  });
});

describe("rule f on approve", () => {
  it("sa2 approver cannot approve sa1 proposal onto an sa2 contact", async () => {
    const r = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", phone: "+27825555555" });
    if (!("proposal" in r)) throw new Error("x");
    const res = await decide(r.proposal.id, "approve", "sa2");
    expect(res.status).not.toBe(200);
    expect(mem.read("contacts/c1")!.phone).toBe(ANN.phone);
    expect(mem.read("contacts/c2")!.phone).toBe(ANN.phone);
  });
});
