import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A refused OAuth state (expired, or finished by a different signed-in user)
 * sends the user back to the sub-account's settings page — which its admins
 * can open — not to /agency/*, which only the agency owner can.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}), getAdminAuth: () => ({}) }));
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
const { GET } = await import("./route");
const { signMetaState } = await import("@/lib/comms/meta");

const callback = (state: string | null, uid: string) =>
  GET(
    new Request(`https://app.test/api/meta/callback?code=c${state === null ? "" : `&state=${encodeURIComponent(state)}`}`, {
      headers: { "x-user-uid": uid },
    }),
  );
const where = (res: Response) => {
  const u = new URL(res.headers.get("location")!);
  return u.pathname + u.search;
};

beforeEach(() => vi.useRealTimers());

describe("GET /api/meta/callback — refused state", () => {
  it("a different user's state lands on that sub-account's settings", async () => {
    const res = await callback(signMetaState("sa1", "uid-a", "n"), "uid-b");
    expect(where(res)).toBe("/sa/sa1/dashboard/settings?meta=bad_state");
  });

  it("an expired state does too", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-23T10:00:00Z") });
    const state = signMetaState("sa1", "uid-a", "n");
    vi.setSystemTime(new Date("2026-09-23T11:00:00Z"));
    expect(where(await callback(state, "uid-a"))).toBe("/sa/sa1/dashboard/settings?meta=bad_state");
  });

  it("a missing or unparseable state goes to /dashboard", async () => {
    expect(where(await callback(null, "uid-a"))).toBe("/dashboard?meta=bad_state");
    expect(where(await callback("junk", "uid-a"))).toBe("/dashboard?meta=bad_state");
  });
});
