import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A workflow belongs to one sub-account and must only ever act on that
 * sub-account's contacts. Neither the trigger (which enrols) nor the step
 * runner (which messages, tags, calls webhooks) may load a contact from
 * another sub-account by id: the trigger reports `contact_not_found`, and a
 * run pointing at a foreign contact fails without running the step. Real
 * engine over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
}));

const { fireWorkflowTrigger, runStep } = await import("./engine");

beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("subAccounts/sa1", { name: "A", agencyId: "ag1" });
  mem.seed("contacts/cB", {
    subAccountId: "saB", agencyId: "ag1", mode: "live", name: "Foreign",
    phone: "+27820000000", tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    name: "Tagger", subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
    createdByUid: "u_owner",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "touched" }, next: null } },
  });
});

it("the trigger will not enrol another sub-account's contact", async () => {
  const out = await fireWorkflowTrigger({
    agencyId: "ag1", subAccountId: "sa1", type: "contact.tag.added", contactId: "cB",
    context: {},
  });
  expect(out.reason).toBe("contact_not_found");
  expect(out.enrolled).toEqual([]);
  expect(mem.list("workflowRuns")).toEqual([]);
});

it("a run pointing at a foreign contact fails without running the step", async () => {
  mem.seed("workflowRuns/r1", {
    workflowId: "wf1", subAccountId: "sa1", agencyId: "ag1", contactId: "cB",
    status: "running", currentNodeId: "n1", history: [], context: {},
  });
  await runStep("r1", "n1");
  expect(mem.read("workflowRuns/r1")?.status).toBe("failed");
  expect(mem.read("contacts/cB")?.tags).toEqual([]);
  expect(mem.list("contacts/cB/activities")).toEqual([]);
});
