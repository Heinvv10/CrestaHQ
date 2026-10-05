import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth as subKey, mem, setupDispatchTests } from "@/test/agent-dispatch-harness";
import type { AgencyApiAuthContext } from "@/lib/api/auth";

/**
 * An agency key's direct write in a client sub-account is attributable as an
 * AGENCY key's in the client's audit trail (AGENCY_AGENT_API_PLAN.md D5
 * "Audit actor: {type: api_key, id: keyId} + keyLevel; agent.write under the
 * target"): every audit row written with an `api_key` actor carries the
 * key's level. Folded in from the A3b breaker's repro.
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
const agentWrites = () =>
  mem.all().filter((d) => (d.data as { action?: string }).action === "agent.write").map((d) => d.data as Record<string, unknown>);

describe("agent.write audit rows name the key's level (D5)", () => {
  it("an agency key's create_contact in sa1 → the sa1 agent.write row says keyLevel agency", async () => {
    expect(await dispatchAgentTool(agencyKey, "create_contact", { subAccountId: "sa1", name: "Ben" })).toMatchObject({ ok: true });
    const rows = agentWrites();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subAccountId: "sa1", actor: { type: "api_key", id: "ak1" } });
    expect(rows[0]!.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: "keyLevel", after: "agency" })]));
  });

  it("control: a sub-account key's row says keyLevel sub-account", async () => {
    expect(await dispatchAgentTool(subKey, "create_contact", { name: "Cat" })).toMatchObject({ ok: true });
    expect(agentWrites()[0]!.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "keyLevel", after: "sub-account" })]),
    );
  });
});

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
