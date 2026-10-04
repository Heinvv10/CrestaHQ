import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * refresh-claims gives an agency role only to an ACTIVE `agencyMembers` row
 * (PR #346 review, breaker REPRO 2): a removed owner re-minting their token
 * must not keep owner claims.
 */

const mem = createMemoryFirestore();
const setCustomUserClaims = vi.fn(async () => {});
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ setCustomUserClaims }),
}));

const { POST } = await import("./route");
const refresh = async () =>
  (await (await POST(new Request("http://x/api/auth/refresh-claims", { method: "POST", headers: { "x-user-uid": "owner1" } }))).json()) as {
    claims: { agencyRole: string | null; role: string };
  };

beforeEach(() => {
  mem.clear();
  setCustomUserClaims.mockClear();
  mem.seed("users/owner1", { status: "active", primaryAgencyId: "ag1" });
});

describe("POST /api/auth/refresh-claims", () => {
  it("an active owner row keeps the owner role", async () => {
    mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
    expect((await refresh()).claims).toMatchObject({ agencyRole: "owner", role: "admin" });
  });

  it("a removed owner row gets no agency role, on the token as well as the response", async () => {
    mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "removed" });
    expect((await refresh()).claims).toMatchObject({ agencyRole: null, role: "collaborator" });
    expect(setCustomUserClaims).toHaveBeenCalledWith("owner1", expect.objectContaining({ agencyRole: null }));
  });
});
