import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * STL-1 form capabilities, through the real registry over an in-memory
 * Firestore: list_forms shows only this sub-account's forms, create_form
 * anchors the new form to the caller's sub-account and refuses a duplicate
 * name, and the agency variant runs them in the named sub-account.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { getCapability, CapabilityUserError } = await import("@/lib/ai-suite/capabilities");

const ctx = (subAccountId: string) => ({
  uid: "u_admin", email: "admin@x.io", displayName: "", agencyId: "ag1", subAccountId, subAccountRole: "admin",
});
const run = async (name: string, args: Record<string, unknown>, sub = "sa1") => {
  const cap = getCapability(name)!;
  const v = cap.validate(args);
  if (!v.ok) throw new Error(v.error);
  return cap.execute(ctx(sub), v.args);
};

beforeEach(() => {
  mem.seed("subAccounts/sa3", { agencyId: "ag2" });
  mem.seed("forms/f_mine", { name: "Contact us", subAccountId: "sa1", agencyId: "ag1", enabled: true, submissionCount: 3, fields: [{}, {}], createdAt: new Date(1) });
  mem.seed("forms/f_theirs", { name: "Secret intake", subAccountId: "sa2", agencyId: "ag1", enabled: true, submissionCount: 9, fields: [], createdAt: new Date(2) });
});

describe("list_forms", () => {
  it("lists only this sub-account's forms, with the public URL and the embed snippet", async () => {
    const r = await run("list_forms", {});
    expect(r.resultText).toContain("Contact us");
    expect(r.resultText).toContain("id: f_mine");
    expect(r.resultText).toContain("/f/f_mine");
    expect(r.resultText).toContain("<iframe src=");
    expect(r.resultText).not.toContain("Secret intake");
    expect(r.resultText).not.toContain("f_theirs");
  });

  it("from the other sub-account, shows only that one's", async () => {
    const r = await run("list_forms", {}, "sa2");
    expect(r.resultText).toContain("Secret intake");
    expect(r.resultText).not.toContain("Contact us");
  });

  it("the agent surface lists the key's own sub-account only", async () => {
    const r = await dispatchAgentTool(auth, "list_forms", {});
    expect(r).toMatchObject({ ok: true });
    expect(JSON.stringify(r)).toContain("f_mine");
    expect(JSON.stringify(r)).not.toContain("f_theirs");
  });
});

describe("create_form", () => {
  it("creates the form in the caller's sub-account, with its agency", async () => {
    const r = await run("create_form", { name: "Free quote", template: "contact" });
    expect(r.ref?.kind).toBe("form");
    expect(mem.read(`forms/${r.ref!.id}`)).toMatchObject({
      name: "Free quote", subAccountId: "sa1", agencyId: "ag1", createdByUid: "u_admin", enabled: true,
    });
    expect(r.resultText).toContain(`/f/${r.ref!.id}`);
  });

  it("anchors to ctx, not to anything in the args", async () => {
    const r = await getCapability("create_form")!.execute(ctx("sa1"), { name: "Sneaky", template: "blank", subAccountId: "sa3", agencyId: "ag2" });
    expect(mem.read(`forms/${r.ref!.id}`)).toMatchObject({ subAccountId: "sa1", agencyId: "ag1" });
  });

  it("refuses a duplicate name (case and spacing aside), writing nothing", async () => {
    const before = mem.list("forms").length;
    await expect(run("create_form", { name: "  contact US " })).rejects.toBeInstanceOf(CapabilityUserError);
    await expect(run("create_form", { name: "contact us" })).rejects.toThrow(/already exists \(id f_mine/);
    expect(mem.list("forms")).toHaveLength(before);
  });

  it("another sub-account's form of the same name is no duplicate", async () => {
    const r = await run("create_form", { name: "Secret intake" });
    expect(mem.read(`forms/${r.ref!.id}`)).toMatchObject({ subAccountId: "sa1" });
  });

  it("validates the name and preset", () => {
    const v = getCapability("create_form")!.validate;
    expect(v({ name: "" }).ok).toBe(false);
    expect(v({ name: "x".repeat(81) }).ok).toBe(false);
    expect(v({ name: "Hi‮there" }).ok).toBe(false);
    expect(v({ name: "Quote", template: "survey" }).ok).toBe(false);
    expect(v({ name: "Quote" })).toEqual({ ok: true, args: { name: "Quote", template: "contact" } });
  });

  it("the agent surface writes it directly into the key's sub-account", async () => {
    const r = await dispatchAgentTool(auth, "create_form", { name: "Agent form" });
    expect(r).toMatchObject({ ok: true });
    expect(mem.list("forms").filter((f) => f.name === "Agent form")).toEqual([
      expect.objectContaining({ subAccountId: "sa1", agencyId: "ag1" }),
    ]);
  });
});

describe("agency variants", () => {
  const owner = { uid: "owner1", email: "o@x.io", displayName: "", agencyId: "ag1" };

  it("create_form_in_sub_account creates in the named sub-account", async () => {
    const cap = getCapability("create_form_in_sub_account")!;
    const v = cap.validate({ subAccountId: "sa2", subAccountName: "Two", name: "Owner form" });
    if (!v.ok) throw new Error(v.error);
    const r = await cap.execute(owner, v.args);
    expect(mem.read(`forms/${r.ref!.id}`)).toMatchObject({ subAccountId: "sa2", agencyId: "ag1" });
  });

  it("refuses a sub-account of another agency", async () => {
    const cap = getCapability("list_forms_in_sub_account")!;
    const v = cap.validate({ subAccountId: "sa3", subAccountName: "Theirs" });
    if (!v.ok) throw new Error(v.error);
    await expect(cap.execute(owner, v.args)).rejects.toBeInstanceOf(CapabilityUserError);
  });
});
