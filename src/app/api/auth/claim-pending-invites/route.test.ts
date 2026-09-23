import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An existing account attaches pending invites by email only when Firebase
 * Auth says that address is verified — an unverified user can carry any
 * email. Real route over the in-memory Firestore; getUser is stubbed.
 */

const account = { uid: "uid_u", email: "Invitee@Example.com", emailVerified: false, displayName: "U" };

vi.mock("@/lib/firebase/admin", async () => {
  const base = (await import("@/test/gbp-sync-store")).adminMock();
  return { ...base, getAdminAuth: () => ({ getUser: async () => ({ ...account }) }) };
});

import { mem } from "@/test/gbp-sync-store";
import { POST } from "./route";

const SA = "sa_1";

function seedInvite(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`invites/${id}`, {
    email: "invitee@example.com",
    agencyId: "ag_1",
    subAccountId: SA,
    subAccountRole: "admin",
    agencyRole: null,
    invitedByUid: "uid_admin",
    acceptedByUid: null,
    acceptedAt: null,
    revokedAt: null,
    ...extra,
  });
}

async function claim() {
  const res = await POST(
    new Request("http://127.0.0.1:3100/api/auth/claim-pending-invites", {
      method: "POST",
      headers: { "x-user-uid": "uid_u" },
    }),
  );
  return { status: res.status, body: (await res.json()) as { attached: unknown[] } };
}

const member = () => mem.read(`subAccounts/${SA}/subAccountMembers/uid_u`);

beforeEach(() => {
  mem.clear();
  account.emailVerified = false;
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture" });
});

describe("claim-pending-invites", () => {
  it("attaches nothing for an unverified address that matches an invite", async () => {
    seedInvite("inv_1");
    expect(await claim()).toEqual({ status: 200, body: { attached: [] } });
    expect(member()).toBeUndefined();
    expect(mem.read("invites/inv_1")?.acceptedByUid).toBeNull();
  });

  it("attaches the invite for a verified address", async () => {
    account.emailVerified = true;
    seedInvite("inv_1");
    expect((await claim()).body.attached).toEqual([{ subAccountId: SA, name: "Fixture" }]);
    expect(member()).toMatchObject({ role: "admin", status: "active" });
    expect(mem.read("invites/inv_1")?.acceptedByUid).toBe("uid_u");
  });

  it("ignores revoked and already-accepted invites even when verified", async () => {
    account.emailVerified = true;
    seedInvite("inv_r", { revokedAt: new Date() });
    seedInvite("inv_a", { acceptedByUid: "uid_other" });
    expect((await claim()).body.attached).toEqual([]);
    expect(member()).toBeUndefined();
  });
});
