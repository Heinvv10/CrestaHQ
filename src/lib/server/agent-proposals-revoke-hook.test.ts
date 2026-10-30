import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The revoke hook rejects the revoked key's pending proposals wherever they
 * sit: an agency key's rows live under every sub-account it reached, so the
 * sweep matches rows by key (`agentKeyRef(row)`), never by one sub-account.
 * Real revokeApiKey, hook and sweep over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { revokeApiKey } = await import("@/lib/firestore/api-keys");
await import("./agent-proposals-revoke-hook");

const status = (id: string) => mem.read(`agentProposals/${id}`)?.status;
const reason = (id: string) => mem.read(`agentProposals/${id}`)?.reason;
function seedRow(id: string, row: Record<string, unknown>) {
  mem.seed(`agentProposals/${id}`, { agencyId: "ag1", keyId: "k1", status: "pending", ...row });
}

beforeEach(() => {
  mem.clear();
  // The agency key ag1/k1's rows in two sub-accounts, one already executing.
  seedRow("p_ag_sa1", { subAccountId: "sa1", keyLevel: "agency" });
  seedRow("p_ag_sa4", { subAccountId: "sa4", keyLevel: "agency" });
  seedRow("p_ag_exec", { subAccountId: "sa4", keyLevel: "agency", status: "executing" });
  // Another agency's agency key and a sub-account key, both with id k1.
  seedRow("p_other_agency", { agencyId: "ag2", subAccountId: "sa9", keyLevel: "agency" });
  seedRow("p_sub_sa1", { subAccountId: "sa1", keyLevel: "sub-account" });
  // A row from before agency keys: no keyLevel, a sub-account key's.
  seedRow("p_legacy_sa1", { subAccountId: "sa1" });
});

describe("agent-proposals revoke hook", () => {
  it("revoking an agency key rejects its pending rows in sa1 AND sa4 (key_revoked), nothing else", async () => {
    await revokeApiKey({ level: "agency", agencyId: "ag1" }, "k1", "owner1");
    expect(mem.read("agencies/ag1/apiKeys/k1")?.revokedAt).toBeTruthy();
    for (const id of ["p_ag_sa1", "p_ag_sa4"]) {
      expect([status(id), reason(id)]).toEqual(["rejected", "key_revoked"]);
    }
    expect(status("p_ag_exec")).toBe("executing");
    for (const id of ["p_other_agency", "p_sub_sa1", "p_legacy_sa1"]) expect(status(id)).toBe("pending");
  });

  it("revoking a sub-account key rejects its own rows only, legacy rows included", async () => {
    await revokeApiKey({ level: "sub-account", subAccountId: "sa1" }, "k1", "owner1");
    for (const id of ["p_sub_sa1", "p_legacy_sa1"]) {
      expect([status(id), reason(id)]).toEqual(["rejected", "key_revoked"]);
    }
    for (const id of ["p_ag_sa1", "p_ag_sa4", "p_other_agency"]) expect(status(id)).toBe("pending");
  });
});
