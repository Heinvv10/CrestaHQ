import { describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The two Agent API reach gates (AGENCY_AGENT_API_PLAN.md A2, D3): with both
 * on, an agency key reaches the sub-account, so the Workspace Assistant's
 * `set_feature_gate` may switch either off but never on. (No Agent API key
 * reaches it: it is agency-level, and `agentCallable` refuses it.) Enabling
 * stays a Manage-dialog click.
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

describe("set_feature_gate: gate names are FEATURE_GATES' own keys, never Object.prototype's", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("%s: validate refuses it, and so does execute, writing nothing", async (gate) => {
    expect(cap().validate(args(gate, true))).toMatchObject({ ok: false, error: expect.stringMatching(/pick a gate/) });
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity" });
    await expect(cap().execute(ctx, args(gate, true))).rejects.toThrow(/pick a gate/);
    expect(mem.read("subAccounts/sa1")).toEqual({ agencyId: "ag1", name: "Velocity" });
  });
});
