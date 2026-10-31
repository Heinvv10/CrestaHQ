import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// The real api-cleanup sweep runs in the replay tests; its unrelated sweeps are inert here.
vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: async () => true,
  publishCallback: async () => ({ messageId: "m1" }),
}));
vi.mock("@/lib/server/agents-watchdog-service", () => ({ sweepOldWatchdogRuns: async () => 0 }));
vi.mock("@/lib/server/agent-proposals-sweeps", () => ({
  sweepAgentProposals: async () => ({ collection: "agentProposals", deleted: 0, hitCap: false }),
}));
const setMemberSessionCookie = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/community/member-session", () => ({ setMemberSessionCookie }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
const { mem } = await import("@/test/gbp-sync-store");
const { signMemberMagicLinkToken } = await import("@/lib/community/member-auth");
const { GET, HEAD, POST } = await import("./route");
const { runApiCleanup } = await import("@/app/api/cron/api-cleanup/route");

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

afterEach(() => vi.useRealTimers());

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
      expect(html).toContain("onsubmit=\"this.querySelector('button').disabled=true\"");
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

  it("POST signs in once (303 into the community); the same link again mints no second session", async () => {
    const token = signMemberMagicLinkToken(SA, "member@example.com");
    const first = await signIn(token);
    expect(first.status).toBe(303);
    expect(location(first)).toBe(`/c/${SA}`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
    expect(uses()).toEqual([expect.objectContaining({ subAccountId: SA, expiresAt: expect.any(Date) })]);

    // A double-tap's second POST: sent into the community (the first POST set
    // the cookie), but no session is minted by this request.
    const second = await signIn(token);
    expect(second.status).toBe(303);
    expect(location(second)).toBe(`/c/${SA}`);
    expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
    expect(ensureMember).toHaveBeenCalledTimes(2);
    expect(uses()).toHaveLength(1);
  });

  it("an expired or forged token is still refused", async () => {
    expect(location(await signIn("not-a-token"))).toBe(`/c/${SA}/login?error=expired`);
    expect(setMemberSessionCookie).not.toHaveBeenCalled();
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

  describe("a link that outlives the default 15 minutes (purchase emails: 24 h)", () => {
    const H = 60 * 60 * 1000;
    const DAY = 24 * H;
    const at = (t0: number, ms: number) => vi.setSystemTime(t0 + ms);

    // After every wait the real api-cleanup sweep runs, as it does daily: the
    // use record must survive it for as long as the link still verifies.
    it("used once, then replayed at +1 h, +12 h and +23 h after each sweep: refused every time", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      const token = signMemberMagicLinkToken(SA, "member@example.com", "g1", DAY);
      expect(location(await signIn(token))).toBe(`/c/${SA}`);
      expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);

      for (const wait of [1 * H, 12 * H, 23 * H]) {
        at(t0, wait);
        expect((await runApiCleanup()).ok).toBe(true);
        expect(uses()).toHaveLength(1);
        const replay = await signIn(token);
        expect(location(replay)).toBe(`/c/${SA}`);
      }
      // Three replays, no second session.
      expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
    });

    it("the record is only swept after the link has died, and then the link is refused anyway", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      const token = signMemberMagicLinkToken(SA, "member@example.com", undefined, DAY);
      await signIn(token);

      at(t0, DAY + 10 * 60 * 1000);
      await runApiCleanup();
      expect(uses()).toEqual([]);
      expect(location(await signIn(token))).toBe(`/c/${SA}/login?error=expired`);
      expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
    });

    it("a default-TTL link behaves as before: record kept until just after the link dies, then swept", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      const token = signMemberMagicLinkToken(SA, "member@example.com");
      await signIn(token);
      const [use] = uses();
      // The 15-minute link, plus the 5-minute margin.
      expect((use.expiresAt as Date).getTime() - t0).toBe(20 * 60 * 1000);

      at(t0, 10 * 60 * 1000);
      await runApiCleanup();
      expect(uses()).toHaveLength(1);
      expect(location(await signIn(token))).toBe(`/c/${SA}`);

      at(t0, 16 * 60 * 1000);
      await runApiCleanup();
      expect(uses()).toHaveLength(1);
      expect(location(await signIn(token))).toBe(`/c/${SA}/login?error=expired`);

      at(t0, 21 * 60 * 1000);
      await runApiCleanup();
      expect(uses()).toEqual([]);
      expect(location(await signIn(token))).toBe(`/c/${SA}/login?error=expired`);
      expect(setMemberSessionCookie).toHaveBeenCalledTimes(1);
    });
  });
});
