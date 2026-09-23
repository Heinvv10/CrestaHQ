import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A community magic link is ONE sign-in. Replaying the same emailed link
 * (forwarded mail, a shared screenshot, browser history on a shared machine)
 * within its 15-minute TTL must not mint a second 30-day session.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/community/gate", () => ({
  getCommunityGate: async () => ({ enabled: true, agencyId: "ag1" }),
}));
const ensureMember = vi.hoisted(() => vi.fn(async () => ({ id: "m1", status: "active" })));
vi.mock("@/lib/community/member-account", () => ({ ensureMember }));
const setMemberSessionCookie = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/community/member-session", () => ({ setMemberSessionCookie }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
const { mem } = await import("@/test/gbp-sync-store");
const { signMemberMagicLinkToken } = await import("@/lib/community/member-auth");
const { GET } = await import("./route");

const SA = "sa1";
const verify = (token: string) =>
  GET(new Request(`https://app.test/api/community/${SA}/login/verify?token=${encodeURIComponent(token)}`), {
    params: Promise.resolve({ saId: SA }),
  });
const location = (res: Response) => new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search;

beforeEach(() => {
  mem.clear();
  ensureMember.mockClear();
  setMemberSessionCookie.mockClear();
});

describe("GET /api/community/[saId]/login/verify", () => {
  it("signs in once, then refuses the same link", async () => {
    const token = signMemberMagicLinkToken(SA, "member@example.com");
    expect(location(await verify(token))).toBe(`/c/${SA}`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);

    expect(location(await verify(token))).toBe(`/c/${SA}/login?error=expired`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two concurrent uses through", async () => {
    const token = signMemberMagicLinkToken(SA, "member@example.com");
    await Promise.all([verify(token), verify(token)]);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("a fresh link for the same email still works", async () => {
    await verify(signMemberMagicLinkToken(SA, "member@example.com"));
    expect(location(await verify(signMemberMagicLinkToken(SA, "member@example.com")))).toBe(`/c/${SA}`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(2);
  });
});
