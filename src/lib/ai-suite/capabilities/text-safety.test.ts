import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * PR #271 carry-forward: a ZWNJ / ZWJ joining letters or emoji is text and
 * is accepted, every other invisible character stays refused; create_contact
 * trims before its check like the other writers; tags pass the same check;
 * and an APPROVED channel change is a person's write (no byAgent webhook).
 */

const emit = vi.hoisted(() => vi.fn(async (_input: { type: string; byAgent?: boolean }) => undefined));
vi.mock("@/lib/api/webhooks/dispatch", async (orig) => ({ ...((await orig()) as object), emitWebhookEvent: emit }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

beforeEach(() => {
  emit.mockClear();
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", email: "a@x.io", tags: [], customFields: {} });
});
const created = (r: unknown, collection: string) => mem.read(`${collection}/${(r as { ref: { id: string } }).ref.id}`)!;

describe("joiners inside words are text", () => {
  const PERSIAN = "\u0633\u0627\u0631\u0627\u200c\u062c\u0627\u0646"; // a name with a ZWNJ between letters
  const FAMILY = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467} Family Co"; // an emoji ZWJ sequence

  it("a Persian name with a ZWNJ is accepted by create_contact", async () => {
    expect(created(await dispatchAgentTool(auth, "create_contact", { name: PERSIAN }), "contacts").name).toBe(PERSIAN);
  });

  it("an emoji ZWJ sequence is accepted by create_company", async () => {
    expect(created(await dispatchAgentTool(auth, "create_company", { name: FAMILY }), "companies").name).toBe(FAMILY);
  });

  it.each([
    ["a lone ZWSP", "A\u200bB"],
    ["a ZWJ at the start", "\u200dAnn"],
    ["a ZWJ between spaces", "Ann \u200d Lee"],
    ["a ZWNJ next to a digit", "Ann\u200c1"],
    ["a ZWNJ after a digit", "1\u200cAnn"],
  ])("%s is still refused", async (_label, name) => {
    expect(await dispatchAgentTool(auth, "create_contact", { name })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("create_contact trims before its check, like the other writers", () => {
  it("a trailing newline is trimmed, not refused", async () => {
    expect(created(await dispatchAgentTool(auth, "create_contact", { name: "Bob\n" }), "contacts").name).toBe("Bob");
  });

  it("an inner newline is still refused", async () => {
    expect(await dispatchAgentTool(auth, "create_contact", { name: "Bob\nLee" })).toMatchObject({ ok: false });
  });
});

describe("tags pass the unsafe-text check", () => {
  it.each([
    ["create_contact", { name: "Tagged", tags: ["vip\u200b"] }],
    ["update_contact", { contactId: "c1", tags: ["a\u0000"] }],
    ["add_tags", { contactId: "c1", tags: ["a\u202eb"] }],
    ["remove_tags", { contactId: "c1", tags: ["a\nb"] }],
  ])("%s refuses an unsafe tag, writing nothing", async (name, args) => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, name, args)).toMatchObject({ ok: false, code: "invalid_args" });
    expect(JSON.stringify(mem.all())).toBe(before);
  });
});

describe("an approved channel change is a person's write", () => {
  it("its contact.updated webhook carries no byAgent, and it holds no enrolment", async () => {
    const r = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", email: "new@x.io" });
    if (!("proposal" in r)) throw new Error("expected a proposal");
    expect((await decide(r.proposal.id, "approve")).status).toBe(200);
    const updated = emit.mock.calls.map(([e]) => e).filter((e) => e.type === "contact.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]).not.toHaveProperty("byAgent");
    expect(mem.list("agentProposals").map((p) => p.approval)).toEqual(["channel_change"]);
  });
});

describe("characters that render as nothing without being Cf", () => {
  it.each([
    ["U+034F", "A\u034fB"], ["U+115F", "A\u115fB"], ["U+1160", "A\u1160B"],
    ["U+3164", "A\u3164B"], ["U+FFA0", "A\uffa0B"], ["U+2800", "A\u2800B"],
  ])("%s is refused", async (_label, name) => {
    expect(await dispatchAgentTool(auth, "create_company", { name })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("U+FE0F (emoji presentation) is accepted", async () => {
    const name = "\u2764\ufe0f Heart Co";
    expect(created(await dispatchAgentTool(auth, "create_company", { name }), "companies").name).toBe(name);
  });
});

describe("company email and website get the strict rule", () => {
  it.each([
    ["email", { name: "Co", email: "a\u200db@x.io" }],
    ["website", { name: "Co", website: "ex\u200dample.com" }],
  ])("a joiner between letters in the %s is refused", async (_label, args) => {
    expect(await dispatchAgentTool(auth, "create_company", args)).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("create_contact's email gets the strict rule", () => {
  it("a joiner between letters in the email is refused", async () => {
    expect(await dispatchAgentTool(auth, "create_contact", { name: "Ann", email: "a\u200db@x.io" }))
      .toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("oneLine", () => {
  it("keeps U+FE0F (emoji presentation) while stripping every other default-ignorable", async () => {
    const { oneLine } = await import("./text-safety");
    expect(oneLine("\u2764\ufe0f Co\u2065\u3164")).toBe("\u2764\ufe0f Co");
  });
});
