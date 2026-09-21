import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Removing a member deletes their Google Calendar connection (S2): a removed
 * member's tokens must not linger for busy loading or pushes to use.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "uid_admin", subAccountId: "sa_1", subAccountRole: "admin" }),
}));

const copies = vi.hoisted(() => ({ calls: [] as Array<{ uid: string; tokensStillThere: boolean }> }));
vi.mock("@/lib/google-calendar/push", async () => {
  const { state: s } = await import("@/test/google-oauth-harness");
  return {
    removeMemberGoogleCopies: async (sa: string, uid: string) => {
      copies.calls.push({ uid, tokensStillThere: s.docs.has(`subAccounts/${sa}/private/googleCalendar_${uid}`) });
    },
  };
});

import { SUB, resetHarness, state } from "@/test/google-oauth-harness";
import { DELETE } from "./route";

const CAL = (uid: string) => `subAccounts/${SUB}/private/googleCalendar_${uid}`;

beforeEach(() => {
  resetHarness();
  copies.calls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  state.docs.set(CAL("uid_member"), { uid: "uid_member", refreshToken: "r" });
  state.docs.set(CAL("uid_admin2"), { uid: "uid_admin2", refreshToken: "r2" });
});

describe("member removal", () => {
  it("deletes the removed member's calendar connection, and only theirs", async () => {
    const res = await DELETE(new Request("http://x/api", { method: "DELETE" }), {
      params: Promise.resolve({ id: SUB, uid: "uid_member" }),
    });
    expect(res.status).toBe(200);
    expect(state.docs.get(`subAccounts/${SUB}/subAccountMembers/uid_member`)?.status).toBe("removed");
    expect(state.docs.has(CAL("uid_member"))).toBe(false);
    expect(state.docs.has(CAL("uid_admin2"))).toBe(true);
    // Their Google copies were taken down FIRST, while the tokens still existed.
    expect(copies.calls).toEqual([{ uid: "uid_member", tokensStillThere: true }]);
  });
});
