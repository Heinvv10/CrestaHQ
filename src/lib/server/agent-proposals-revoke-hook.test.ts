import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The revoke hook sweeps a sub-account key's pending proposals, and today does
 * nothing for an agency key, which no transport accepts yet (A2). The agency
 * case is pinned so A3b, which lets agency keys propose, has to change it.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const sweep = vi.fn(async () => {});
vi.mock("@/lib/server/agent-proposals-sweeps", () => ({ sweepRevokedKeyProposals: sweep }));

const { revokeApiKey } = await import("@/lib/firestore/api-keys");
await import("./agent-proposals-revoke-hook");

beforeEach(() => {
  mem.clear();
  sweep.mockClear();
});

describe("agent-proposals revoke hook", () => {
  it("sweeps a revoked sub-account key's proposals", async () => {
    await revokeApiKey({ level: "sub-account", subAccountId: "sa1" }, "k1", "owner1");
    expect(sweep).toHaveBeenCalledWith({ subAccountId: "sa1", keyId: "k1" });
  });

  it("A3b must replace this: revoking an agency key sweeps nothing today", async () => {
    await revokeApiKey({ level: "agency", agencyId: "ag1" }, "k1", "owner1");
    expect(mem.read("agencies/ag1/apiKeys/k1")?.revokedAt).toBeTruthy();
    // When A3b lets agency keys propose, this expectation is WRONG: the
    // revoke must sweep the key's pending rows in every sub-account it reached.
    expect(sweep).not.toHaveBeenCalled();
  });
});
