import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A pending invite is claimed by presenting the token from its invite link,
 * not by knowing the invitee's email. Real signup route over the in-memory
 * Firestore; the Firebase Auth admin calls are recorded, not real. The last
 * test creates the invite through the real members service, so the token
 * the email would carry is the one signup accepts.
 */

const created: Array<Record<string, unknown>> = [];
/** Auth accounts that already exist, by email. */
const accounts = new Map<string, { uid: string; emailVerified: boolean }>();
const deleted: string[] = [];
const updated: Array<[string, Record<string, unknown>]> = [];

vi.mock("@/lib/firebase/admin", async () => {
  const base = (await import("@/test/gbp-sync-store")).adminMock();
  return {
    ...base,
    getAdminAuth: () => ({
      createUser: async (props: Record<string, unknown>) => {
        if (accounts.has(props.email as string)) {
          throw Object.assign(new Error("exists"), { code: "auth/email-already-exists" });
        }
        created.push(props);
        return { uid: `uid_${created.length}` };
      },
      setCustomUserClaims: async () => undefined,
      deleteUser: async (uid: string) => {
        deleted.push(uid);
        for (const [e, a] of accounts) if (a.uid === uid) accounts.delete(e);
      },
      updateUser: async (uid: string, props: Record<string, unknown>) => {
        updated.push([uid, props]);
      },
      getUserByEmail: async (email: string) => {
        const a = accounts.get(email);
        if (!a) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
        return { ...a, email, disabled: false, customClaims: {} };
      },
    }),
  };
});
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => false,
  sendEmail: async () => undefined,
}));

import { mem } from "@/test/gbp-sync-store";
import { hashInviteToken } from "@/lib/server/invite-token";
import { createInviteServerSide } from "@/lib/server/members-service";
import { POST } from "./route";

const SA = "sa_1";
const EMAIL = "invitee@example.com";
const TOKEN = "correct-token";

function seedInvite(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`invites/${id}`, {
    email: EMAIL,
    agencyId: "ag_1",
    subAccountId: SA,
    subAccountRole: "admin",
    agencyRole: null,
    invitedByUid: "uid_admin",
    acceptedByUid: null,
    acceptedAt: null,
    revokedAt: null,
    tokenHash: hashInviteToken(TOKEN),
    ...extra,
  });
}

async function signup(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://127.0.0.1:3100/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "secret123", ...body }),
    }),
  );
  return res.status;
}

const member = (uid: string) => mem.read(`subAccounts/${SA}/subAccountMembers/${uid}`);

beforeEach(() => {
  delete process.env.BOOTSTRAP_ADMIN_EMAIL;
  mem.clear();
  created.length = 0;
  deleted.length = 0;
  updated.length = 0;
  accounts.clear();
  mem.seed("appConfig/main", { adminUid: "uid_admin" });
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture" });
});

describe("signup against a pending invite", () => {
  it("refuses the invitee's email without the invite token", async () => {
    seedInvite("inv_1");
    expect(await signup({})).toBe(403);
    expect(created).toHaveLength(0);
    expect(mem.read("invites/inv_1")?.acceptedByUid).toBeNull();
  });

  it("refuses a wrong token", async () => {
    seedInvite("inv_1");
    expect(await signup({ inviteToken: "guessed" })).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("claims the invite with the right token, as a verified address", async () => {
    seedInvite("inv_1");
    expect(await signup({ inviteToken: TOKEN })).toBe(200);
    expect(created).toEqual([expect.objectContaining({ email: EMAIL, emailVerified: true })]);
    expect(member("uid_1")).toMatchObject({ role: "admin", status: "active" });
    expect(mem.read("invites/inv_1")?.acceptedByUid).toBe("uid_1");
  });

  it("records the person who sent the invite as addedByUid, not the deployment admin", async () => {
    seedInvite("inv_1", { invitedByUid: "uid_inviter" });
    expect(await signup({ inviteToken: TOKEN })).toBe(200);
    expect(member("uid_1")?.addedByUid).toBe("uid_inviter");
  });

  it("falls back to the deployment admin for a legacy invite with no invitedByUid", async () => {
    seedInvite("inv_1", { invitedByUid: undefined });
    expect(await signup({ inviteToken: TOKEN })).toBe(200);
    expect(member("uid_1")?.addedByUid).toBe("uid_admin");
  });

  it("claims the invite the token belongs to when the email has several", async () => {
    seedInvite("inv_other", { subAccountId: "sa_other", tokenHash: hashInviteToken("other") });
    seedInvite("inv_1");
    expect(await signup({ inviteToken: TOKEN })).toBe(200);
    expect(mem.read("invites/inv_1")?.acceptedByUid).toBe("uid_1");
    expect(mem.read("invites/inv_other")?.acceptedByUid).toBeNull();
  });

  it("refuses a revoked or already-accepted invite even with its token", async () => {
    seedInvite("inv_1", { revokedAt: new Date() });
    expect(await signup({ inviteToken: TOKEN })).toBe(403);
    mem.clear();
    mem.seed("appConfig/main", { adminUid: "uid_admin" });
    seedInvite("inv_1", { acceptedByUid: "uid_x" });
    expect(await signup({ inviteToken: TOKEN })).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("refuses a pre-token invite (no tokenHash) — it must be re-sent", async () => {
    seedInvite("inv_1", { tokenHash: undefined });
    expect(await signup({ inviteToken: TOKEN })).toBe(403);
    expect(await signup({ inviteToken: "" })).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("still lets the first signup become the agency owner without a token", async () => {
    mem.clear();
    process.env.BOOTSTRAP_ADMIN_EMAIL = EMAIL;
    expect(await signup({})).toBe(200);
    expect(created).toEqual([expect.not.objectContaining({ emailVerified: true })]);
    expect(mem.read("appConfig/main")?.adminUid).toBe("uid_1");
  });

  it("replaces an out-of-app account on the invitee's email with a fresh one, never adopting its uid", async () => {
    accounts.set(EMAIL, { uid: "uid_squatter", emailVerified: false });
    seedInvite("inv_1");
    expect(await signup({})).toBe(403);
    expect(deleted).toEqual([]);
    expect(await signup({ inviteToken: TOKEN })).toBe(200);
    expect(deleted).toEqual(["uid_squatter"]);
    expect(created).toEqual([expect.objectContaining({ email: EMAIL, emailVerified: true })]);
    expect(member("uid_1")).toMatchObject({ role: "admin" });
    expect(member("uid_squatter")).toBeUndefined();
  });

  it("sends an in-app account holder to sign in, verified, leaving the invite for the claim route", async () => {
    accounts.set(EMAIL, { uid: "uid_legacy", emailVerified: false });
    mem.seed("users/uid_legacy", { uid: "uid_legacy", status: "active" });
    seedInvite("inv_1");
    expect(await signup({ inviteToken: TOKEN })).toBe(409);
    expect(updated).toEqual([["uid_legacy", { emailVerified: true }]]);
    expect(deleted).toEqual([]);
    expect(created).toHaveLength(0);
    expect(mem.read("invites/inv_1")?.acceptedByUid).toBeNull();
  });

  it("accepts the token from a link minted by the invite service, and a resend rotates it", async () => {
    const first = await createInviteServerSide({
      subAccountId: SA,
      invitedByUid: "uid_admin",
      auditActor: { type: "user", id: "uid_admin" },
      email: EMAIL,
      role: "admin",
    });
    const second = await createInviteServerSide({
      subAccountId: SA,
      invitedByUid: "uid_admin",
      auditActor: { type: "user", id: "uid_admin" },
      email: EMAIL,
      role: "admin",
    });
    expect(second.inviteId).toBe(first.inviteId);
    const tokenOf = (url: string) => new URL(url, "http://x").searchParams.get("invite");
    expect(tokenOf(first.inviteUrl)).toBeTruthy();
    expect(tokenOf(second.inviteUrl)).not.toBe(tokenOf(first.inviteUrl));
    expect(JSON.stringify(mem.read(`invites/${first.inviteId}`))).not.toContain(
      tokenOf(second.inviteUrl)!,
    );

    expect(await signup({ inviteToken: tokenOf(first.inviteUrl) })).toBe(403);
    expect(await signup({ inviteToken: tokenOf(second.inviteUrl) })).toBe(200);
    expect(member("uid_1")).toMatchObject({ role: "admin" });
  });
});

describe("claiming a fresh workspace (no appConfig yet)", () => {
  beforeEach(() => mem.clear());

  it("refuses every signup while BOOTSTRAP_ADMIN_EMAIL is unset, with a message naming the fix", async () => {
    const res = await POST(
      new Request("http://127.0.0.1:3100/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "first-comer@example.com", password: "secret123" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("BOOTSTRAP_ADMIN_EMAIL");
    expect(created).toHaveLength(0);
    expect(mem.read("appConfig/main")).toBeUndefined();
  });

  it("refuses a different email when it is set", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = "owner@example.com";
    expect(await signup({})).toBe(403);
    expect(created).toHaveLength(0);
  });
});
