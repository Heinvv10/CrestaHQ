import { describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The X0 gates (agent monitors, sell online, AI texts): the Workspace
 * Assistant's `set_feature_gate` may switch each off but never on.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { getCapability } = await import("@/lib/ai-suite/capabilities");
const { FEATURE_GATES } = await import("@/lib/ai-suite/capabilities/helpers");
const cap = () => getCapability("set_feature_gate")!;
const ctx = { uid: "owner1", email: "", displayName: "", agencyId: "ag1", agencyRole: "owner" as const };
const args = (gate: string, enabled: boolean) => ({ subAccountId: "sa1", subAccountName: "Velocity", gate, enabled });

describe.each([
  ["agents", "agentsEnabledByAgency"],
  ["sell-online", "sellOnlineEnabledByAgency"],
  ["ai-outbound-sms", "aiOutboundSmsEnabledByAgency"],
])("set_feature_gate %s", (gate, field) => {
  it("maps to its field with assistantMayEnable false", () => {
    expect(FEATURE_GATES[gate]).toMatchObject({ field, assistantMayEnable: false });
  });

  it("validate refuses switching it on", () => {
    expect(cap().validate(args(gate, true))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only be switched on by the agency owner/),
    });
  });

  it("execute refuses switching it on, even without validate, and writes nothing", async () => {
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity", [field]: false });
    await expect(cap().execute(ctx, args(gate, true))).rejects.toThrow(/only be switched on by the agency owner/);
    expect(mem.read("subAccounts/sa1")?.[field]).toBe(false);
  });

  it("still switches it off", async () => {
    expect(cap().validate(args(gate, false)).ok).toBe(true);
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Velocity", [field]: true });
    await cap().execute(ctx, args(gate, false));
    expect(mem.read("subAccounts/sa1")?.[field]).toBe(false);
  });
});
