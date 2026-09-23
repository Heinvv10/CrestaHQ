import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Completing a task writes `task_completed` on its linked contact. A legacy
 * task can hold a contactId from ANOTHER sub-account; that contact's timeline
 * must not receive the row.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => {} }));

const { setTaskCompletedServerSide } = await import("./tasks-service");

beforeEach(() => {
  mem.clear();
  mem.seed("contacts/mine", { subAccountId: "sa1", agencyId: "ag1" });
  mem.seed("contacts/theirs", { subAccountId: "sa2", agencyId: "ag1" });
});

const seedTask = (contactId: string) =>
  mem.seed("tasks/t1", { subAccountId: "sa1", agencyId: "ag1", title: "Call", completed: false, contactId, mode: "live" });

describe("setTaskCompletedServerSide — task_completed row", () => {
  it("lands on this sub-account's contact", async () => {
    seedTask("mine");
    await setTaskCompletedServerSide({ taskId: "t1", completed: true, userId: "u1" });
    expect(mem.list("contacts/mine/activities")).toEqual([expect.objectContaining({ type: "task_completed" })]);
  });

  it("is not written onto a contact in another sub-account, while the task still completes", async () => {
    seedTask("theirs");
    const res = await setTaskCompletedServerSide({ taskId: "t1", completed: true, userId: "u1" });
    expect(res).not.toBeNull();
    expect(mem.read("tasks/t1")).toMatchObject({ completed: true });
    expect(mem.list("contacts/theirs/activities")).toEqual([]);
  });
});

describe("setTaskCompletedServerSide — refusal is logged as tenancy", () => {
  it("names the tenancy refusal, not a failed write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedTask("theirs");
    await setTaskCompletedServerSide({ taskId: "t1", completed: true, userId: "u1" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tenancy refusal"));
    warn.mockRestore();
  });
});
