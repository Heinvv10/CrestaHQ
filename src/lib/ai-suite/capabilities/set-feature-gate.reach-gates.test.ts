import { describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The two Agent API reach gates (AGENCY_AGENT_API_PLAN.md A2, D3): with both
 * on, an agency key reaches the sub-account, so `set_feature_gate` — the
 * Workspace Assistant's and every Agent API key's path — may switch either
 * off but never on. Enabling stays a Manage-dialog click.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { getCapability } = await import("@/lib/ai-suite/capabilities");
const cap = () => getCapability("set_feature_gate")!;
const ctx = { uid: "owner1", email: "", displayName: "", agencyId: "ag1", agencyRole: "owner" as const };
const args = (gate: string, enabled: boolean) => ({ subAccountId: "sa1", subAccountName: "Velocity", gate, enabled });

describe.each([
  ["agent-api", "agentApiEnabledByAgency"],
  ["api-access", "apiAccessEnabledByAgency"],
])("set_feature_gate %s", (gate, field) => {
  it("validate refuses switching it on", () => {
    const v = cap().validate(args(gate, true));
    expect(v).toMatchObject({ ok: false, error: expect.stringMatching(/only be switched on by the agency owner/) });
  });

  it("execute refuses switching it on, even without validate, and writes nothing", async () => {
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity", [field]: false });
    await expect(cap().execute(ctx, args(gate, true))).rejects.toThrow(/only be switched on by the agency owner/);
    expect(mem.read("subAccounts/sa1")?.[field]).toBe(false);
  });

  it("validate still allows switching it off", () => {
    expect(cap().validate(args(gate, false)).ok).toBe(true);
  });
});
