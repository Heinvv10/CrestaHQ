import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, caller, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * The PR7 contact proposals approved through the real decide route:
 * update_contact_channels changes the contact to exactly the reviewed
 * values, delete_contact deletes it, and both re-check at approve that the
 * contact is still in this sub-account.
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
  tags: [], customFields: {}, territoryId: "global",
};
beforeEach(() => {
  mem.seed("contacts/c1", ANN);
  mem.seed("contacts/c1/notes/n1", { body: "note" });
});
async function proposeId(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await dispatchAgentTool(auth, name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}

describe("update_contact_channels", () => {
  it("approve writes the reviewed phone and email, as the approver", async () => {
    const id = await proposeId("update_contact_channels", { contactId: "c1", phone: "+27829999999", email: "New@X.io" });
    expect(row(id).preview).toEqual([
      { label: "Contact", value: "Ann" },
      { label: "Phone", value: "+27821111111 → +27829999999" },
      { label: "Email", value: "ann@x.io → new@x.io" },
    ]);
    const res = await decide(id, "approve");
    expect(res.status).toBe(200);
    expect(mem.read("contacts/c1")).toMatchObject({ phone: "+27829999999", email: "new@x.io" });
    expect(row(id).status).toBe("executed");
    expect(mem.list("aiSuiteActions")).toEqual([
      expect.objectContaining({ capability: "update_contact_channels", confirmedByUid: "u_admin" }),
    ]);
  });

  it("a contact moved to another sub-account since the proposal → 409, nothing written", async () => {
    const id = await proposeId("update_contact_channels", { contactId: "c1", phone: "+27829999999" });
    mem.seed("contacts/c1", { ...ANN, subAccountId: "sa2" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "preview_unavailable" });
    expect(mem.read("contacts/c1")!.phone).toBe(ANN.phone);
    expect(row(id).status).toBe("pending");
  });

  it("the current phone changed since the proposal → the approver must look again", async () => {
    const id = await proposeId("update_contact_channels", { contactId: "c1", phone: "+27829999999" });
    mem.seed("contacts/c1", { ...ANN, phone: "+27823333333" });
    const first = await decide(id, "approve");
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: "preview_changed" });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("contacts/c1")!.phone).toBe("+27829999999");
  });
});

describe("delete_contact", () => {
  it("approve by an admin deletes the contact and its subcollections", async () => {
    const id = await proposeId("delete_contact", { contactId: "c1" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(200);
    expect(mem.read("contacts/c1")).toBeUndefined();
    expect(mem.read("contacts/c1/notes/n1")).toBeUndefined();
    expect(row(id).status).toBe("executed");
  });

  it("a collaborator cannot approve it", async () => {
    const id = await proposeId("delete_contact", { contactId: "c1" });
    caller.role = "collaborator";
    expect((await decide(id, "approve")).status).toBe(403);
    expect(mem.read("contacts/c1")).toBeDefined();
  });

  it("the preview says it will fail while a deal still points at the contact", async () => {
    mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", title: "Fibre" });
    const id = await proposeId("delete_contact", { contactId: "c1" });
    expect(row(id).preview).toContainEqual({ label: "Will fail", value: "Still linked to 1 deal; clear those first." });
  });

  it("linked to a deal since the proposal → the approver sees the new warning; approving anyway fails with the reason", async () => {
    const id = await proposeId("delete_contact", { contactId: "c1" });
    mem.seed("deals/d1", { subAccountId: "sa1", agencyId: "ag1", contactId: "c1", title: "Fibre" });
    const first = await decide(id, "approve");
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: "preview_changed" });
    const res = await decide(id, "approve");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: "failed", error: expect.stringContaining("1 deal") });
    expect(mem.read("contacts/c1")).toBeDefined();
  });

  it("a contact moved to another sub-account since the proposal → 409, not deleted", async () => {
    const id = await proposeId("delete_contact", { contactId: "c1" });
    mem.seed("contacts/c1", { ...ANN, subAccountId: "sa2" });
    expect((await decide(id, "approve")).status).toBe(409);
    expect(mem.read("contacts/c1")).toBeDefined();
  });
});
