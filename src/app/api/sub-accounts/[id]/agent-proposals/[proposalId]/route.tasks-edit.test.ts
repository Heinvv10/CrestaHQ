import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * update_task / delete_task (PR12) through the real dispatch and decide
 * route: an edit goes through the v1 task route's own patch, stamped as the
 * agent's, with links and territory kept in the sub-account; a delete is a
 * hard_delete proposal that shows the whole task.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const TASK = { subAccountId: "sa1", agencyId: "ag1", title: "Call Ann", notes: "", completed: false, contactId: null, territoryId: "global" };
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;

beforeEach(() => {
  mem.seed("tasks/t1", TASK);
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", territoryId: "north" });
  mem.seed("contacts/c_other", { subAccountId: "sa2", agencyId: "ag1", name: "Theirs" });
});

describe("update_task", () => {
  it("writes the asked fields, stamped; linking a contact moves the task to its territory", async () => {
    expect(await call("update_task", { taskId: "t1", title: "Call Ann back", dueAt: "2030-01-12", contactId: "c1" })).toMatchObject({ ok: true });
    const t = mem.read("tasks/t1")!;
    expect(t).toMatchObject({ title: "Call Ann back", contactId: "c1", territoryId: "north", lastAgentEditKey: "abcd1234" });
    expect((t.dueAt as Date).toISOString()).toBe("2030-01-12T00:00:00.000Z");
    expect(await call("update_task", { taskId: "t1", dueAt: null, contactId: null })).toMatchObject({ ok: true });
    expect(mem.read("tasks/t1")).toMatchObject({ dueAt: null, contactId: null, territoryId: "global" });
  });

  it.each([
    ["another sub-account's contact", { contactId: "c_other" }, "That contact isn't in this workspace."],
    ["another sub-account's task", { taskId: "t_other", title: "X" }, "That task isn't in this workspace."],
  ])("%s -> refused, unchanged", async (_label, patch, message) => {
    mem.seed("tasks/t_other", { ...TASK, subAccountId: "sa2" });
    expect(await call("update_task", { taskId: "t1", ...patch })).toMatchObject({ ok: false, message });
    expect(mem.read("tasks/t1")).toEqual(TASK);
  });

  it.each([
    ["nothing to change", {}],
    ["an empty title", { title: "  " }],
    ["an invisible character", { title: "Call\u200b" }],
    ["a bad due date", { dueAt: "12/01/2030" }],
    ["a contact id that is a path", { contactId: "c1/x/y" }],
  ])("%s -> invalid args", async (_label, patch) => {
    expect(await call("update_task", { taskId: "t1", ...patch })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("delete_task", () => {
  it("a hard_delete proposal showing the whole task; approve deletes it", async () => {
    mem.seed("tasks/t1", { ...TASK, notes: "Ask about fibre", contactId: "c1", completed: true });
    const r = await call("delete_task", { taskId: "t1" });
    const id = (r as { proposal: { id: string } }).proposal.id;
    expect(row(id).approval).toBe("hard_delete");
    expect(rowOf(id, "Delete task")).toBe("Call Ann");
    expect(rowOf(id, "Notes")).toBe("Ask about fibre");
    expect(rowOf(id, "Done")).toBe("yes");
    expect(rowOf(id, "Linked to")).toBe("contact c1");
    expect(mem.read("tasks/t1")).toBeDefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("tasks/t1")).toBeUndefined();
  });

  it("another sub-account's task -> refused at propose", async () => {
    mem.seed("tasks/t_other", { ...TASK, subAccountId: "sa2" });
    expect(await call("delete_task", { taskId: "t_other" })).toMatchObject({ ok: false, message: "That task isn't in this workspace." });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("moved to another sub-account inside the delete's transaction -> failed, kept", async () => {
    const id = ((await call("delete_task", { taskId: "t1" })) as { proposal: { id: string } }).proposal.id;
    beforeNextTransaction(async () => beforeNextTransaction(async () => mem.seed("tasks/t1", { ...TASK, subAccountId: "sa2" })));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("tasks/t1")).toBeDefined();
  });
});
