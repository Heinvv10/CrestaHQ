import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * No agent capability builds a Firestore path from a caller-supplied id that
 * is not ONE doc id (breaker, PR #269): "c1/sub/y" would address a
 * subcollection doc carrying the parent's subAccountId, pass the tenant
 * check, and be read, written or (after approval) deleted. Every
 * agent-callable capability with an `…Id` parameter is driven with such an
 * id against a real subcollection doc; each must refuse and leave the store
 * byte-identical.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool, agentCallable } = await import("@/lib/api/agent-dispatch");
const { AI_SUITE_CAPABILITIES } = await import("@/lib/ai-suite/capabilities");

const SUB = { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Row", title: "Row", territoryId: "global", tags: [] };
/** [capability, args with every id pointing at a subcollection doc]. */
const ID_CASES: Array<[string, Record<string, unknown>]> = [
  ["get_contact", { contactId: "c1/sub/y" }],
  ["update_contact", { contactId: "c1/sub/y", name: "X", tags: ["t"] }],
  ["add_tags", { contactId: "c1/sub/y", tags: ["t"] }],
  ["remove_tags", { contactId: "c1/sub/y", tags: ["t"] }],
  ["update_contact_channels", { contactId: "c1/sub/y", phone: "+27829999999" }],
  ["delete_contact", { contactId: "c1/sub/y" }],
  ["create_deal", { title: "D", value: 1, currency: "ZAR", contactId: "c1/sub/y", contactName: "Row", stage: "new" }],
  ["move_deal_stage", { dealId: "d1/sub/y", dealTitle: "Row", stage: "contacted" }],
  ["create_task", { title: "T", contactId: "c1/sub/y", contactName: "Row" }],
  ["complete_task", { taskId: "t1/sub/y", taskTitle: "Row" }],
  ["create_event", { title: "E", date: "2030-01-10", time: "10:00", contactId: "c1/sub/y", contactName: "Row" }],
];

beforeEach(() => {
  for (const parent of ["contacts/c1", "deals/d1", "tasks/t1"]) {
    mem.seed(parent, SUB);
    mem.seed(`${parent}/sub/y`, SUB);
    // A real top-level doc named like the path's last segment: a service
    // handed `snap.id` ("y") would act on it.
    mem.seed(`${parent.split("/")[0]}/y`, { ...SUB, stageId: "new", completed: false });
  }
});

describe("a caller-supplied id is never a path", () => {
  it("every agent-callable capability with an …Id parameter is in the table", () => {
    const withIds = AI_SUITE_CAPABILITIES.filter(agentCallable)
      .filter((c) => Object.keys((c.parameters as { properties?: object }).properties ?? {}).some((k) => k.endsWith("Id")))
      .map((c) => c.name);
    expect(withIds.sort()).toEqual(ID_CASES.map(([n]) => n).sort());
  });

  it.each(ID_CASES)("%s with an \"x/sub/y\" id → refused, the store byte-identical", async (name, args) => {
    const before = JSON.stringify(mem.all());
    const r = await dispatchAgentTool(auth, name, args);
    expect(r).toMatchObject({ ok: false, httpStatus: 400 });
    expect(JSON.stringify(mem.all())).toBe(before);
  });
});

describe("isDocId", () => {
  it("refuses Firestore's reserved __…__ ids, and get_contact treats one as not found", async () => {
    const { isDocId } = await import("@/lib/server/doc-id");
    expect([isDocId("__c1__"), isDocId("____"), isDocId("c1__"), isDocId("__c1")]).toEqual([false, false, true, true]);
    expect(await dispatchAgentTool(auth, "get_contact", { contactId: "__c1__" })).toMatchObject({
      ok: false, httpStatus: 400, message: "That contact isn't in this workspace.",
    });
  });
});

describe("the contact services refuse a path id themselves", () => {
  it("updateContactServerSide → null, the subcollection doc unchanged", async () => {
    const { updateContactServerSide } = await import("@/lib/server/contacts-service");
    expect(await updateContactServerSide({ contactId: "c1/sub/y", patch: { name: "X" } })).toBeNull();
    expect(mem.read("contacts/c1/sub/y")).toEqual(SUB);
  });

  it("deleteContactServerSide → not_found, nothing deleted", async () => {
    const { deleteContactServerSide } = await import("@/lib/server/contact-delete");
    expect(await deleteContactServerSide({ contactId: "c1/sub/y" })).toEqual({ status: "not_found" });
    expect(mem.read("contacts/c1/sub/y")).toEqual(SUB);
  });
});

describe("update_contact_channels email: nothing the approver can't see", () => {
  it.each([
    ["a zero-width space", "new@x.io\u200b"],
    ["a NUL", "new@x.io\u0000"],
    ["a right-to-left override", "\u202eoi.x@wen"],
  ])("%s → refused, no proposal", async (_label, email) => {
    const r = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", email });
    expect(r).toMatchObject({ ok: false, code: "invalid_args" });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("a plain address is still accepted", async () => {
    const r = await dispatchAgentTool(auth, "update_contact_channels", { contactId: "c1", email: "New@X.io" });
    expect(r).toMatchObject({ ok: true, proposal: { status: "pending" } });
  });
});
