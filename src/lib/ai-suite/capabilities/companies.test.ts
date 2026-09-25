import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, caller, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * PR7b company capabilities on the agent surface, through the real
 * dispatchAgentTool and (for delete_company) the real decide route over an
 * in-memory Firestore: tenancy, the field allowlist, the doc shape the
 * dashboard writes, and an approved delete unlinking only this tenant's
 * contacts.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");
const { buildAgentContext } = await import("@/lib/api/agent-context");

const ACME = { subAccountId: "sa1", agencyId: "ag1", name: "Acme", phone: "", email: "", website: "", address: "", createdByUid: "u1" };
beforeEach(() => {
  mem.seed("companies/co1", ACME);
  mem.seed("companies/co2", { ...ACME, subAccountId: "sa2", name: "Other Co" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", companyId: "co1", company: "Acme" });
  mem.seed("contacts/c2", { subAccountId: "sa1", agencyId: "ag1", name: "Ben", companyId: "co1", company: "Acme" });
  mem.seed("contacts/cx", { subAccountId: "sa2", agencyId: "ag1", name: "Xena", companyId: "co1", company: "Acme" });
});
const companies = () => mem.all().filter((d) => d.path.startsWith("companies/"));

describe("tenancy: an sa2 companyId from an sa1 key", () => {
  it.each([
    ["update_company", { companyId: "co2", name: "Hijacked" }],
    ["delete_company", { companyId: "co2" }],
  ])("%s → a user error, the store byte-identical", async (name, args) => {
    const before = JSON.stringify(mem.all());
    expect(await dispatchAgentTool(auth, name, args)).toMatchObject({
      ok: false, httpStatus: 400, message: "That company isn't in this workspace.",
    });
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([
    ["update_company", { companyId: "co2", name: "Hijacked" }],
    ["delete_company", { companyId: "co2" }],
  ])("%s execute (the approve path too) throws CapabilityUserError", async (name, args) => {
    await expect(getCapability(name)!.execute(buildAgentContext(auth), args)).rejects.toBeInstanceOf(CapabilityUserError);
    expect(mem.read("companies/co2")).toMatchObject({ name: "Other Co" });
  });

  it("updateCompanyServerSide re-checks the sub-account and the id itself", async () => {
    const { updateCompanyServerSide } = await import("@/lib/server/companies-service");
    mem.seed("companies/co1/sub/y", { subAccountId: "sa1", agencyId: "ag1", name: "Sub row" });
    expect(await updateCompanyServerSide({ companyId: "co2", subAccountId: "sa1", data: { name: "X" } })).toBe(false);
    expect(await updateCompanyServerSide({ companyId: "co1/sub/y", subAccountId: "sa1", data: { name: "X" } })).toBe(false);
    expect(mem.read("companies/co2")!.name).toBe("Other Co");
    expect(mem.read("companies/co1/sub/y")!.name).toBe("Sub row");
  });

  it("createCompanyServerSide stamps the tenancy keys over anything in data", async () => {
    const { createCompanyServerSide } = await import("@/lib/server/companies-service");
    const data = { name: "N", phone: "", email: "", website: "", address: "", subAccountId: "sa2", agencyId: "evil" };
    const id = await createCompanyServerSide({ agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", data });
    expect(mem.read(`companies/${id}`)).toMatchObject({ agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1" });
  });

  it("list_companies lists this sub-account's companies only", async () => {
    const r = await dispatchAgentTool(auth, "list_companies", {});
    expect(r).toMatchObject({ ok: true, resultText: expect.stringContaining("Acme — id: co1") });
    expect(JSON.stringify(r)).not.toContain("Other Co");
  });
});

describe("list_companies at its cap", () => {
  it("501 companies → truncated: true and an explicit may-be-incomplete note", async () => {
    for (let i = 0; i < 501; i++) mem.seed(`companies/bulk${i}`, { ...ACME, name: `Bulk ${i}` });
    const r = await dispatchAgentTool(auth, "list_companies", { query: "zzz-not-there" });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect((r as { resultText: string }).resultText).toContain(
      "Showing the first 500 companies; this list may be incomplete, so a name may exist that isn't shown."
    );
  });

  it("under the cap → no flag, no note", async () => {
    const r = await dispatchAgentTool(auth, "list_companies", {});
    expect(r).not.toHaveProperty("truncated");
    expect((r as { resultText: string }).resultText).not.toContain("incomplete");
  });
});

describe("allowlist and doc shape", () => {
  it("create_company writes the dashboard's doc shape; tenancy keys come from the key, never the args", async () => {
    const r = await dispatchAgentTool(auth, "create_company", {
      name: " New Co ", email: "hi@new.co", agencyId: "evil", subAccountId: "sa2", createdByUid: "x", createdAt: "then", rogue: "x",
    });
    expect(r).toMatchObject({ ok: true, ref: { kind: "company" } });
    const doc = mem.read(`companies/${(r as { ref: { id: string } }).ref.id}`)!;
    expect(Object.keys(doc).sort()).toEqual(
      ["address", "agencyId", "createdAt", "createdByUid", "email", "lastAgentEditAt", "lastAgentEditKey", "name", "phone", "subAccountId", "updatedAt", "website"]
    );
    expect(doc).toMatchObject({
      name: "New Co", email: "hi@new.co", phone: "", website: "", address: "",
      agencyId: "ag1", subAccountId: "sa1", createdByUid: "apikey:abcd1234",
    });
  });

  it("update_company writes only the form fields", async () => {
    await dispatchAgentTool(auth, "update_company", {
      companyId: "co1", website: "acme.io", subAccountId: "sa2", agencyId: "evil", createdByUid: "x",
    });
    expect(mem.read("companies/co1")).toMatchObject({ ...ACME, website: "acme.io" });
  });

  it.each([
    ["an empty name", "update_company", { companyId: "co1", name: " " }],
    ["a non-text field", "update_company", { companyId: "co1", phone: 123 }],
    ["a bad email", "create_company", { name: "X", email: "nope" }],
    ["an over-long field", "create_company", { name: "x".repeat(501) }],
    ["no name", "create_company", { phone: "1" }],
    ["nothing to change", "update_company", { companyId: "co1", agencyId: "evil" }],
  ])("%s → invalid_args, nothing written", async (_label, name, args) => {
    const before = JSON.stringify(companies());
    expect(await dispatchAgentTool(auth, name, args)).toMatchObject({ ok: false, code: "invalid_args" });
    expect(JSON.stringify(companies())).toBe(before);
  });
});

describe("delete_company through the decide route", () => {
  const proposeDelete = async () => {
    const r = await dispatchAgentTool(auth, "delete_company", { companyId: "co1" });
    if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
    return r.proposal.id;
  };

  it("the preview names the company and how many contacts it unlinks", async () => {
    const id = await proposeDelete();
    expect(row(id).preview).toEqual([
      { label: "Delete company", value: "Acme" },
      { label: "Id", value: "co1" },
      { label: "Created", value: "(unknown)" },
      { label: "Contacts unlinked", value: "2 (they stay, keeping the company name as text)" },
    ]);
    expect(row(id)).toMatchObject({ approval: "hard_delete", targetScoped: false });
  });

  it("approve by an admin deletes it and unlinks only this sub-account's contacts", async () => {
    const id = await proposeDelete();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("companies/co1")).toBeUndefined();
    expect(mem.read("contacts/c1")).toMatchObject({ companyId: null, company: "Acme" });
    expect(mem.read("contacts/c2")).toMatchObject({ companyId: null });
    expect(mem.read("contacts/cx")).toMatchObject({ companyId: "co1" });
  });

  it("a collaborator gets 403, nothing deleted", async () => {
    const id = await proposeDelete();
    caller.role = "collaborator";
    expect((await decide(id, "approve")).status).toBe(403);
    expect(mem.read("companies/co1")).toBeDefined();
  });

  it("a company moved to another sub-account since the proposal → 409, not deleted", async () => {
    const id = await proposeDelete();
    mem.seed("companies/co1", { ...ACME, subAccountId: "sa2" });
    expect((await decide(id, "approve")).status).toBe(409);
    expect(mem.read("companies/co1")).toBeDefined();
  });
});
