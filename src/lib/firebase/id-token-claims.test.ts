import { describe, expect, it, vi } from "vitest";
import type { ParsedToken } from "firebase/auth";
import { loadIdTokenClaims, readActiveCachedClaims, readOwnerClaim } from "./id-token-claims";

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

describe("readActiveCachedClaims", () => {
  it("returns the cached claims, without a refresh, when they carry status active", async () => {
    const user = fakeUser(async () => ({ claims: owner }));
    expect(await readActiveCachedClaims(user)).toEqual(owner);
    expect(user.getIdTokenResult).toHaveBeenCalledWith(false);
    expect(user.getIdTokenResult).not.toHaveBeenCalledWith(true);
  });

  it("returns null when the cached token has no active status", async () => {
    expect(await readActiveCachedClaims(fakeUser(async () => ({ claims: {} })))).toBeNull();
    const removed = fakeUser(async () => ({ claims: { ...owner, status: "removed" } }));
    expect(await readActiveCachedClaims(removed)).toBeNull();
  });

  it("returns null when the token cannot be read", async () => {
    const user = fakeUser(async () => {
      throw new Error("network");
    });
    expect(await readActiveCachedClaims(user)).toBeNull();
  });
});
