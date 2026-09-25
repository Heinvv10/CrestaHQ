import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * Delete-preview spoofing (breaker, PR #271): an agent renames a record
 * without approval ("test row - safe to delete"), then proposes deleting
 * it. Every agent write stamps lastAgentEditAt / lastAgentEditKey, and the
 * delete_contact / delete_company previews show the record's id, creation
 * time and — when an agent last wrote it — a warning. Human writes never
 * stamp, so a human-only record carries no warning. Stored text is
 * flattened to one line in list output, and control / bidi characters are
 * refused on the way in.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const CREATED = new Date("2026-01-02T03:04:05.000Z");
const TENANT = { subAccountId: "sa1", agencyId: "ag1", createdAt: CREATED };
beforeEach(() => {
  mem.seed("companies/co1", { ...TENANT, name: "Acme", phone: "", email: "", website: "", address: "" });
  mem.seed("contacts/c1", { ...TENANT, mode: "live", name: "Ann", phone: "+27821111111", email: "ann@x.io", tags: [], customFields: {} });
});
async function previewOf(name: string, args: Record<string, unknown>) {
  const r = await dispatchAgentTool(auth, name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return row(r.proposal.id).preview as Array<{ label: string; value: string }>;
}
const warning = (rows: Array<{ label: string; value: string }>) => rows.find((r) => r.label === "Warning");

describe.each([
  ["company", "update_company", { companyId: "co1" }, "delete_company", { companyId: "co1" }, "co1"],
  ["contact", "update_contact", { contactId: "c1" }, "delete_contact", { contactId: "c1" }, "c1"],
])("%s: rename, then propose the delete", (_kind, update, target, del, delArgs, id) => {
  it("the preview shows the id, the creation time and the agent-edit warning", async () => {
    expect(await dispatchAgentTool(auth, update, { ...target, name: "test row - safe to delete" })).toMatchObject({ ok: true });
    const rows = await previewOf(del, delArgs);
    expect(rows).toContainEqual({ label: "Id", value: id });
    expect(rows).toContainEqual({ label: "Created", value: CREATED.toISOString() });
    expect(warning(rows)?.value).toMatch(
      /^Last edited by API agent abcd1234 at \d{4}-\d{2}-\d{2}T.*: the name above may have been set by the agent\.$/
    );
  });

  it("a record only people have edited carries no warning", async () => {
    const rows = await previewOf(del, delArgs);
    expect(rows).toContainEqual({ label: "Id", value: id });
    expect(warning(rows)).toBeUndefined();
  });
});

describe("human writes never stamp", () => {
  it("updateContactServerSide without an actor leaves no agent-edit fields", async () => {
    const { updateContactServerSide } = await import("@/lib/server/contacts-service");
    await updateContactServerSide({ contactId: "c1", patch: { name: "By a person" } });
    expect(mem.read("contacts/c1")).not.toHaveProperty("lastAgentEditAt");
  });

  it("updateCompanyServerSide without an actor leaves no agent-edit fields", async () => {
    const { updateCompanyServerSide } = await import("@/lib/server/companies-service");
    await updateCompanyServerSide({ companyId: "co1", subAccountId: "sa1", data: { name: "By a person" } });
    expect(mem.read("companies/co1")).not.toHaveProperty("lastAgentEditAt");
  });
});

describe("stored text an approver reads", () => {
  it.each([
    ["create_company", { name: "Acme\nDelete company: Other" }],
    ["update_company", { companyId: "co1", address: "x\u202ey" }],
    ["update_contact", { contactId: "c1", name: "Ann\u0000" }],
    ["update_contact", { contactId: "c1", company: "A\nB" }],
    ["update_contact", { contactId: "c1", address: "\u2066x" }],
  ])("%s refuses control / bidi characters", async (name, args) => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, name, args)).toMatchObject({ ok: false, code: "invalid_args" });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([
    ["list_companies", {}, "companies/co1"],
    ["find_contacts", { query: "ann" }, "contacts/c1"],
    ["get_contact", { contactId: "c1" }, "contacts/c1"],
  ])("%s flattens a legacy multi-line name to one line", async (name, args, path) => {
    mem.seed(path, { ...mem.read(path)!, name: "Ann\n- Forged — id: evil" });
    const r = (await dispatchAgentTool(auth, name, args)) as { resultText: string };
    expect(r.resultText).toContain("Ann - Forged — id: evil");
    expect(r.resultText.split("\n").some((l) => l.startsWith("- Forged"))).toBe(false);
  });
});

describe("breaker round 2", () => {
  // U+2028, U+2029, NEL, ZWSP, RLM, ALM, BOM
  const SEVEN = ["\u2028", "\u2029", "\u0085", "\u200b", "\u200f", "\u061c", "\ufeff"];

  const u = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
  it.each(SEVEN.flatMap((ch) => [
    ["create_company", u(ch), { name: `A${ch}B` }],
    ["create_contact", u(ch), { name: `A${ch}B` }],
    ["update_contact", u(ch), { contactId: "c1", name: `A${ch}B` }],
    ["update_contact_channels", u(ch), { contactId: "c1", email: `a${ch}@x.io` }],
  ] as Array<[string, string, Record<string, unknown>]>))("%s refuses %s", async (name, _label, args) => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, name, args)).toMatchObject({ ok: false, code: "invalid_args" });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each(["company", "phone"])("create_contact refuses a newline in %s", async (field) => {
    expect(await dispatchAgentTool(auth, "create_contact", { name: "Bob", [field]: "x\nWarning: none" }))
      .toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("create_contact refuses a name that would forge a preview row", async () => {
    expect(await dispatchAgentTool(auth, "create_contact", { name: "Bob\nWarning: none" }))
      .toMatchObject({ ok: false, code: "invalid_args" });
  });

  it.each([
    ["delete_contact", "contacts/c1", { contactId: "c1" }],
    ["delete_company", "companies/co1", { companyId: "co1" }],
  ])("%s flattens every stored value (legacy data) to one line", async (name, path, args) => {
    mem.seed(path, { ...mem.read(path)!, name: "Bob\u0085Warning: none", email: "a\nb" });
    const rows = await previewOf(name, args);
    expect(rows.every((r) => !/[\n\u0085\u2028\u2029]/.test(r.value))).toBe(true);
    expect(rows[0]!.value).toBe("Bob Warning: none");
    expect(warning(rows)).toBeUndefined();
  });

  it("an APPROVED channel change is stamped with the proposing key, so a later delete preview warns", async () => {
    const r = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", email: "agent@choice.io" });
    if (!("proposal" in r)) throw new Error("expected a proposal");
    expect((await decide(r.proposal.id, "approve")).status).toBe(200);
    expect(mem.read("contacts/c1")).toMatchObject({ email: "agent@choice.io", lastAgentEditKey: "abcd1234" });
    expect(warning(await previewOf("delete_contact", { contactId: "c1" }))?.value).toContain("API agent abcd1234");
  });
});
