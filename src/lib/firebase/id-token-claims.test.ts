import { describe, expect, it, vi } from "vitest";
import type { ParsedToken } from "firebase/auth";
import { loadIdTokenClaims, readOwnerClaim } from "./id-token-claims";

const owner = { agencyId: "ag_1", agencyRole: "owner", status: "active" };

function fakeUser(impl: (force?: boolean) => Promise<{ claims: ParsedToken }>) {
  return { getIdTokenResult: vi.fn(impl) };
}

describe("loadIdTokenClaims", () => {
  it("uses the forced refresh when it succeeds", async () => {
    const user = fakeUser(async (force) => ({
      claims: force ? owner : { agencyRole: "stale" },
    }));
    expect(await loadIdTokenClaims(user)).toEqual(owner);
    expect(user.getIdTokenResult).toHaveBeenCalledTimes(1);
  });

  it("falls back to the cached token when the forced refresh fails", async () => {
    const user = fakeUser(async (force) => {
      if (force) throw new Error("network");
      return { claims: owner };
    });
    expect(await loadIdTokenClaims(user)).toEqual(owner);
    expect(user.getIdTokenResult).toHaveBeenNthCalledWith(1, true);
    expect(user.getIdTokenResult).toHaveBeenNthCalledWith(2, false);
  });

  it("returns empty claims only when both reads fail", async () => {
    const user = fakeUser(async () => {
      throw new Error("network");
    });
    expect(await loadIdTokenClaims(user)).toEqual({});
  });
});

describe("readOwnerClaim", () => {
  it("answers owner / not_owner from a forced refresh", async () => {
    expect(await readOwnerClaim(fakeUser(async () => ({ claims: owner })))).toBe("owner");
    const member = fakeUser(async () => ({ claims: { agencyRole: null, status: "active" } }));
    expect(await readOwnerClaim(member)).toBe("not_owner");
    expect(member.getIdTokenResult).toHaveBeenCalledWith(true);
  });

  it("throws when the token cannot be read, instead of answering not_owner", async () => {
    const user = fakeUser(async () => {
      throw new Error("network");
    });
    await expect(readOwnerClaim(user)).rejects.toThrow("network");
  });
});
