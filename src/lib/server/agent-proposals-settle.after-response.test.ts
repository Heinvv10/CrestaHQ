import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Past the deadline the approve returns while the execute keeps going. On
 * `next start` a request's FIRST after() registered after the response
 * closed never runs, so the in-flight run must be handed to after() when it
 * starts — not once the deadline has passed — and after() must keep the
 * function alive until the late settle lands.
 */

const m = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  transitionIf: vi.fn(async () => true),
}));

const mem = createMemoryFirestore();
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => m.afterTasks.push(task),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/server/agent-proposals", () => ({
  EXECUTE_DEADLINE_MS: 20,
  transitionIf: m.transitionIf,
}));

const { executeAndSettle } = await import("./agent-proposals-settle");

const audit = {
  agencyId: "ag1", subAccountId: "sa1", capability: "create_contact", args: {},
  summary: "Add contact", confirmedByUid: "u1", confirmedByEmail: "u1@example.com",
};

beforeEach(() => {
  mem.clear();
  m.afterTasks.length = 0;
  m.transitionIf.mockClear();
  mem.seed("agentProposals/p1", { status: "executing", claimId: "c1" });
});

it("hands the in-flight run to after() before the race, and after() waits for the late settle", async () => {
  let release!: () => void;
  const pending = executeAndSettle({
    id: "p1",
    claimId: "c1",
    execute: () => new Promise((r) => (release = () => r({ resultText: "Added" }))),
    audit,
  });
  // Registered synchronously, while the response is still open.
  expect(m.afterTasks).toHaveLength(1);

  await expect(pending).resolves.toBe("deadline");
  expect(m.transitionIf).toHaveBeenCalledWith("p1", "executing", { status: "unsettled" }, { claimId: "c1" });

  let settled = false;
  const callback = Promise.resolve(m.afterTasks[0]!()).then(() => void (settled = true));
  await new Promise((r) => setTimeout(r, 0));
  expect(settled).toBe(false);

  release();
  await callback;
  expect(settled).toBe(true);
  expect(mem.list("aiSuiteActions")).toEqual([
    expect.objectContaining({ agentProposalId: "p1", status: "executed" }),
  ]);
});
