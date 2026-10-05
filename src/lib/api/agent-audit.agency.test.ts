import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * Every audit row written with an `api_key` actor names the key's level
 * (AGENCY_AGENT_API_PLAN.md D5 "Audit actor: {type: api_key, id: keyId} +
 * keyLevel"): an agency key's id is not in the client's own key list. The
 * agent.write rows are pinned in agent-audit.test.ts (sub-account key) and
 * agent-proposals.agency.test.ts (agency key, through REST); this file
 * pins the other api_key writer, set_workflow_status. Started from the A3b
 * breaker's repro.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-dispatch-harness")).adminMock());

const { dispatchAgentTool } = await import("./agent-dispatch");

setupDispatchTests();

const agencyKey: AgencyApiAuthContext = { ...subKey, level: "agency", subAccountId: null, keyLevel: "agency", keyId: "ak1" };
const ON = { apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true };

beforeEach(() => {
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "One", timezone: "UTC", ...ON });
});

const auditRows = (action: string) =>
  mem.all().filter((d) => (d.data as { action?: string }).action === action).map((d) => d.data as Record<string, unknown>);

describe("workflow.status_changed by an agent names the key's level (D5)", () => {
  beforeEach(() => {
    mem.seed("workflows/wf1", {
      name: "Nurture", subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: null, nodes: {},
      trigger: { type: "contact.created", filters: { all: [] } },
    });
  });

  it.each([
    ["an agency key", agencyKey, { subAccountId: "sa1" }, "agency", "ak1"],
    ["a sub-account key", subKey, {}, "sub-account", "key1"],
  ] as const)("%s pausing a workflow → its keyLevel on the row", async (_label, key, target, level, keyId) => {
    expect(await dispatchAgentTool(key, "set_workflow_status", { ...target, workflowId: "wf1", status: "paused" })).toMatchObject({ ok: true });
    const [row] = auditRows("workflow.status_changed");
    expect(row).toMatchObject({ subAccountId: "sa1", actor: { type: "api_key", id: keyId } });
    expect(row!.changes).toEqual([
      { field: "status", before: "active", after: "paused" },
      { field: "keyLevel", before: null, after: level },
    ]);
  });
});
