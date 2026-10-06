import { describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * `resolveReach` never reads `subAccounts/null` or `subAccounts/undefined`
 * (A4b breaker, NOTE 1): an id that is the string form of a missing value is
 * refused before any read, like a padded one, even when a doc by that name
 * exists and would otherwise look reachable.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { resolveReach } = await import("./agent-reach");

describe("resolveReach and the literal ids null / undefined", () => {
  it.each(["null", "undefined"])("%j → null, with no read at all", async (id) => {
    mem.seed(`subAccounts/${id}`, { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
    const reads = vi.spyOn(mem.db, "doc");
    expect(await resolveReach("ag1", id)).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
  });

  it("a reachable ordinary id still resolves", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
    expect(await resolveReach("ag1", "sa1")).toBe("sa1");
  });
});
