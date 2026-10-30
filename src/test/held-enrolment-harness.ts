import { beforeEach } from "vitest";
import { mem } from "@/test/agent-proposals-harness";

/**
 * Shared setup for the held-enrolment tests (ruling Q), split across
 * `src/lib/workflows/held-enrolment*.test.ts` to stay under the 300-line cap.
 * Builds on src/test/agent-proposals-harness.ts; each file also declares
 *   vi.mock("@/lib/automations/qstash", async () => (await import("@/test/held-enrolment-harness")).qstashMock());
 */

export const qstashMock = () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "q1" }),
});

export function seedWorkflow(id: string, trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mem.seed(`workflows/${id}`, {
    name: `Workflow ${id}`, subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner", trigger: { filters: { all: [] }, ...trigger },
    nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "x" }, next: null } },
    ...extra,
  });
}
export const runs = () => mem.list("workflowRuns");
export const proposals = () => mem.list("agentProposals");

/** Every held-enrolment test starts with one ACTIVE contact.created workflow, wf1. */
export function setupHeldEnrolmentTests() {
  beforeEach(() => {
    seedWorkflow("wf1", { type: "contact.created" });
  });
}
