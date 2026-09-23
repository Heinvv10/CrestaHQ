import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The run list shows each run's contact name, looked up by id. A run whose
 * contact is outside the sub-account (legacy data) shows the placeholder,
 * never the other tenant's name or email.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { listWorkflowRuns } = await import("./workflows-service");

beforeEach(() => {
  mem.clear();
  mem.seed("contacts/c1", { subAccountId: "sa1", name: "Own" });
  mem.seed("contacts/cB", { subAccountId: "saB", name: "Foreign", email: "f@example.com" });
  const run = { workflowId: "wf1", subAccountId: "sa1", status: "completed", history: [], context: {} };
  mem.seed("workflowRuns/r1", { ...run, id: "r1", contactId: "c1", enrolledAt: new Date(2) });
  mem.seed("workflowRuns/r2", { ...run, id: "r2", contactId: "cB", enrolledAt: new Date(1) });
});

it("names own contacts and hides a foreign one", async () => {
  const runs = await listWorkflowRuns("sa1", "wf1");
  expect(runs.map((r) => [r.id, r.contactName])).toEqual([
    ["r1", "Own"],
    ["r2", "Contact"],
  ]);
});
