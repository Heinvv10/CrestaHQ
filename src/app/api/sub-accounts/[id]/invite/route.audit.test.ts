import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Inviting an email that is already a member overwrites their role. Both
 * entry points — the invite route and the Workspace Assistant's
 * invite_member capability — must record `member.role_changed` when (and only
 * when) the role actually changes. Real route, real capability, real
 * tenancy and members service over the in-memory Firestore; stubbed: the
 * webhook dispatcher and the mailer.
 */

const users = new Map<string, { uid: string; email: string; emailVerified?: boolean }>();

vi.mock("@/lib/firebase/admin", async () => {
  const base = (await import("@/test/gbp-sync-store")).adminMock();
  return {
    ...base,
    getAdminAuth: () => ({
      ...base.getAdminAuth(),
      getUserByEmail: async (email: string) => {
        const u = users.get(email);
        if (!u) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
        return { emailVerified: true, ...u, displayName: "", disabled: false, customClaims: { status: "active", agencyId: "ag_1" } };
      },
    }),
  };
});
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => false,
  sendEmail: async () => undefined,
}));

import { claims, mem } from "@/test/gbp-sync-store";
import { POST } from "./route";

const SA = "sa_1";

async function invite(body: Record<string, unknown>, uid = "uid_admin") {
  const res = await POST(
    new Request(`http://127.0.0.1:3100/api/sub-accounts/${SA}/invite`, {
      method: "POST",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA }) },
  );
  return res.status;
}

const events = () => mem.list("auditEvents");
const role = (uid: string) => mem.read(`subAccounts/${SA}/subAccountMembers/${uid}`)?.role;

beforeEach(() => {
  mem.clear();
  claims.clear();
  users.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag_1", name: "Fixture" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_admin`, { status: "active", role: "admin" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/uid_m`, { uid: "uid_m", status: "active", role: "collaborator" });
  mem.seed(`users/uid_m`, { uid: "uid_m" });
  users.set("m@example.com", { uid: "uid_m", email: "m@example.com" });
  // Claims name a different agency: the event's agencyId must come from the
  // sub-account doc.
  claims.set("uid_admin", { status: "active", agencyId: "ag_claims", agencyRole: null });
});

describe("invite route", () => {
  it("re-inviting a collaborator as admin records the role change", async () => {
    expect(
      await invite({ email: "m@example.com", role: "admin", agencyId: "ag_evil", actor: { type: "user", id: "uid_evil" } }),
    ).toBe(200);
    expect(role("uid_m")).toBe("admin");
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "member.role_changed",
      actor: { type: "user", id: "uid_admin" },
      target: { type: "member", id: "uid_m" },
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: "uid_admin",
      changes: [{ field: "role", before: "collaborator", after: "admin" }],
    });
  });

  it("re-adding a removed member under a new role records it", async () => {
    mem.seed(`subAccounts/${SA}/subAccountMembers/uid_m`, { uid: "uid_m", status: "removed", role: "collaborator" });
    expect(await invite({ email: "m@example.com", role: "admin" })).toBe(200);
    expect(events()).toHaveLength(1);
  });

  it("records nothing when the role is unchanged, for a fresh add, or for a pending invite", async () => {
    expect(await invite({ email: "m@example.com", role: "collaborator" })).toBe(200);
    users.set("n@example.com", { uid: "uid_n", email: "n@example.com" });
    expect(await invite({ email: "n@example.com", role: "admin" })).toBe(200);
    expect(role("uid_n")).toBe("admin");
    expect(await invite({ email: "new@example.com", role: "admin" })).toBe(200);
    expect(events()).toHaveLength(0);
  });
});

describe("invite route — existing accounts", () => {
  it("does not add an unverified account that holds the invitee's email; it gets a token invite", async () => {
    users.set("u@example.com", { uid: "uid_u", email: "u@example.com", emailVerified: false });
    expect(await invite({ email: "u@example.com", role: "admin" })).toBe(200);
    expect(role("uid_u")).toBeUndefined();
    expect(mem.read("userMemberships/uid_u/subAccounts/sa_1")).toBeUndefined();
    const pending = mem.list("invites");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ email: "u@example.com", acceptedByUid: null });
  });

  it("adds a verified account directly", async () => {
    users.set("v@example.com", { uid: "uid_v", email: "v@example.com", emailVerified: true });
    expect(await invite({ email: "v@example.com", role: "admin" })).toBe(200);
    expect(role("uid_v")).toBe("admin");
    expect(mem.list("invites")).toHaveLength(0);
  });

  it("still updates the role of an unverified account that is already an active member", async () => {
    users.set("m@example.com", { uid: "uid_m", email: "m@example.com", emailVerified: false });
    expect(await invite({ email: "m@example.com", role: "admin" })).toBe(200);
    expect(role("uid_m")).toBe("admin");
    expect(mem.list("invites")).toHaveLength(0);
  });
});

describe("invite_member capability", () => {
  let getCapability: typeof import("@/lib/ai-suite/capabilities").getCapability;
  beforeAll(async () => {
    ({ getCapability } = await import("@/lib/ai-suite/capabilities"));
  }, 60_000);

  const ctx = {
    uid: "uid_admin", email: "", displayName: "Admin", agencyId: "ag_claims",
    subAccountId: SA, subAccountRole: "admin",
  };

  it("records the role change as the assistant, on behalf of the user who asked", async () => {
    await getCapability("invite_member")!.execute(ctx, { email: "m@example.com", role: "admin" });
    expect(role("uid_m")).toBe("admin");
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "member.role_changed",
      actor: { type: "ai_agent", id: "workspace-assistant" },
      target: { type: "member", id: "uid_m" },
      agencyId: "ag_1",
      subAccountId: SA,
      createdByUid: "uid_admin",
      changes: [{ field: "role", before: "collaborator", after: "admin" }],
    });
  });

  it("records nothing when the role is unchanged", async () => {
    await getCapability("invite_member")!.execute(ctx, { email: "m@example.com", role: "collaborator" });
    expect(events()).toHaveLength(0);
  });
});
