import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A community magic link is ONE sign-in. Replaying the same emailed link
 * (forwarded mail, a shared screenshot, browser history on a shared machine)
 * within its 15-minute TTL must not mint a second 30-day session — but a mail
 * scanner fetching the link first must not burn it either, so only the POST
 * from the landing page's button signs in.
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
const { GET, HEAD, POST } = await import("./route");

const SA = "sa1";
const base = `https://app.test/api/community/${SA}/login/verify`;
const ctx = () => ({ params: Promise.resolve({ saId: SA }) });
const open = (token: string) => GET(new Request(`${base}?token=${encodeURIComponent(token)}`), ctx());
const signIn = (token: string) =>
  POST(new Request(base, { method: "POST", body: new URLSearchParams({ token }) }), ctx());
const location = (res: Response) => {
  const u = new URL(res.headers.get("location")!);
  return u.pathname + u.search;
};
const uses = () => mem.list("communityMagicLinkUses");

beforeEach(() => {
  mem.clear();
  ensureMember.mockClear();
  setMemberSessionCookie.mockClear();
});

describe("community magic link", () => {
  it("GET and HEAD (what mail scanners send) never consume the link or sign in", async () => {
    const token = signMemberMagicLinkToken(SA, "member@example.com");
    for (let i = 0; i < 3; i++) {
      const res = await open(token);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('method="post"');
      expect(html).not.toMatch(/<script/i);
      expect((await HEAD()).status).toBe(204);
    }
    expect(uses()).toEqual([]);
    expect(setMemberSessionCookie).not.toHaveBeenCalled();
    // …and the link still works for the human afterwards.
    expect(location(await signIn(token))).toBe(`/c/${SA}`);
  });

  it("the GET page carries the token into the POST form, HTML-escaped", async () => {
    const html = await (await open('a"><script>x</script>')).text();
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&#34;&#62;&#60;script&#62;");
  });

  it("POST signs in once (303 into the community), then refuses the same link", async () => {
    const token = signMemberMagicLinkToken(SA, "member@example.com");
    const first = await signIn(token);
    expect(first.status).toBe(303);
    expect(location(first)).toBe(`/c/${SA}`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
    expect(uses()).toEqual([expect.objectContaining({ subAccountId: SA, expiresAt: expect.any(Date) })]);

    expect(location(await signIn(token))).toBe(`/c/${SA}/login?error=expired`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two concurrent POSTs through", async () => {
    const token = signMemberMagicLinkToken(SA, "member@example.com");
    await Promise.all([signIn(token), signIn(token)]);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("a transient member-lookup failure does not burn the link", async () => {
    const token = signMemberMagicLinkToken(SA, "member@example.com");
    ensureMember.mockRejectedValueOnce(new Error("firestore blip"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(location(await signIn(token))).toBe(`/c/${SA}/login?error=error`);
    expect(uses()).toEqual([]);
    expect(location(await signIn(token))).toBe(`/c/${SA}`);
  });

  it("a fresh link for the same email still works", async () => {
    await signIn(signMemberMagicLinkToken(SA, "member@example.com"));
    expect(location(await signIn(signMemberMagicLinkToken(SA, "member@example.com")))).toBe(`/c/${SA}`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(2);
  });
});
