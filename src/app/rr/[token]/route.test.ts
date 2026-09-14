import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /rr/{token} — a customer clicking a tracked review-request link (SP5 d2).
 * The real route over the in-memory Firestore: a valid token 302s to the
 * sub-account's CONFIGURED review URL and stamps `clickedAt` once; anything
 * else is a 404 (never a redirect — no open redirect). It reads no identity
 * header: it is a public path.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, OTHER_SA, SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { issueReviewClickToken } from "@/lib/reviews/click-token";
import { GET, HEAD } from "./route";

const REVIEW_URL = "https://g.page/r/fixture/review";
const ORIGINAL = { ...process.env };
let ipCounter = 0;

function click(token: string, headers: Record<string, string> = {}) {
  return GET(
    new Request(`http://127.0.0.1:3100/rr/${token}`, { headers: { "x-forwarded-for": `203.0.113.${ipCounter}`, ...headers } }),
    { params: Promise.resolve({ token }) },
  );
}
const request = (sa = SA, id = "req_1") => mem.read(`subAccounts/${sa}/reviewRequests/${id}`);

function seedRequest(sa = SA, id = "req_1", more: Record<string, unknown> = {}) {
  mem.seed(`subAccounts/${sa}/reviewRequests/${id}`, {
    agencyId: AGENCY, subAccountId: sa, createdByUid: "review-request", contactId: "c1", channel: "sms",
    source: "dispatcher", trigger: "manual", status: "sent", failureKind: null, messageSid: "SM1",
    sentAt: new Date(), clickedAt: null, feedbackAt: null, tracked: true, ...more,
  });
}

beforeEach(() => {
  resetSync();
  ipCounter++;
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-for-click-tokens";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleReviewConfig: { reviewUrl: REVIEW_URL } });
  seedRequest();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.useRealTimers();
});

describe("a valid click", () => {
  it("302s to the configured review URL and stamps clickedAt", async () => {
    const res = await click(issueReviewClickToken(SA, "req_1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(REVIEW_URL);
    expect(request()?.clickedAt).toBeInstanceOf(Date);
  });

  it("keeps the FIRST click time on a second click", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-14T10:00:00Z") });
    await click(issueReviewClickToken(SA, "req_1"));
    vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
    expect((await click(issueReviewClickToken(SA, "req_1"))).status).toBe(302);
    expect((request()?.clickedAt as Date).toISOString()).toBe("2026-09-14T10:00:00.000Z");
  });

  it("goes to the link configured NOW, not one baked in when it was sent", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleReviewConfig: { reviewUrl: "https://g.page/r/new/review" } });
    expect((await click(issueReviewClickToken(SA, "req_1"))).headers.get("location")).toBe("https://g.page/r/new/review");
  });

  it("ignores an identity header a caller sends (public path)", async () => {
    const res = await click(issueReviewClickToken(SA, "req_1"), { "x-user-uid": "uid_admin" });
    expect(res.status).toBe(302);
  });
});

describe("only a person's GET counts as a click", () => {
  it("HEAD 302s the same way but stamps nothing", async () => {
    const token = issueReviewClickToken(SA, "req_1");
    const res = await HEAD(new Request(`http://127.0.0.1:3100/rr/${token}`, { method: "HEAD", headers: { "x-forwarded-for": `203.0.113.${ipCounter}` } }), {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(REVIEW_URL);
    expect(request()?.clickedAt).toBeNull();
  });

  it.each([
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "WhatsApp/2.23.20.0 A",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Twitterbot/1.0",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0)",
    "Mozilla/5.0 SkypeUriPreview Preview/0.5",
    "LinkedInBot/1.0",
    "Mozilla/5.0 (compatible; Discordbot/2.0)",
    "Mozilla/5.0 (Macintosh) Applebot/0.1",
    "Some link preview fetcher",
  ])("a link-preview fetcher (%s) is redirected but does not stamp", async (ua) => {
    const res = await click(issueReviewClickToken(SA, "req_1"), { "user-agent": ua });
    expect(res.status).toBe(302);
    expect(request()?.clickedAt).toBeNull();
  });

  it("a phone's browser does", async () => {
    await click(issueReviewClickToken(SA, "req_1"), { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" });
    expect(request()?.clickedAt).toBeInstanceOf(Date);
  });
});

describe("everything else is a 404 and stamps nothing", () => {
  it.each([
    ["a forged token", () => `${SA}.req_1.${"0".repeat(64)}`],
    ["a malformed token", () => "nonsense"],
    ["a token for a request that does not exist", () => issueReviewClickToken(SA, "req_missing")],
    ["a token naming another sub-account's id for this request", () => issueReviewClickToken(OTHER_SA, "req_1")],
  ])("%s", async (_l, token) => {
    const res = await click(token());
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(request()?.clickedAt).toBeNull();
  });

  it("an untracked request", async () => {
    seedRequest(SA, "req_1", { tracked: false });
    expect((await click(issueReviewClickToken(SA, "req_1"))).status).toBe(404);
  });

  it("no configured review link, or one that is not https", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleReviewConfig: null });
    expect((await click(issueReviewClickToken(SA, "req_1"))).status).toBe(404);
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleReviewConfig: { reviewUrl: "javascript:alert(1)" } });
    expect((await click(issueReviewClickToken(SA, "req_1"))).status).toBe(404);
    expect(request()?.clickedAt).toBeNull();
  });
});

describe("rate limit keyed like the GBP feed", () => {
  const token = () => issueReviewClickToken(SA, "req_1");
  const hitAs = (headers: Record<string, string>) =>
    GET(new Request(`http://127.0.0.1:3100/rr/${token()}`, { headers }), { params: Promise.resolve({ token: token() }) });

  it("x-real-ip is the client; a spoofed cf-connecting-ip is ignored unless TRUST_CF_CONNECTING_IP=1", async () => {
    const ip = `198.51.100.${ipCounter}`;
    for (let i = 0; i < 60; i++) await hitAs({ "x-real-ip": ip, "cf-connecting-ip": `10.0.${i}.1` });
    expect((await hitAs({ "x-real-ip": ip, "cf-connecting-ip": "10.9.9.9" })).status).toBe(429);
  });

  it("a full table never hands a persistent abuser a fresh budget", async () => {
    const abuser = { "x-real-ip": `192.0.2.${ipCounter}` };
    for (let i = 0; i < 60; i++) await hitAs(abuser);
    for (let n = 0; n < 5_200; n++) {
      await hitAs({ "x-real-ip": `2001:db8::${ipCounter}:${n}` });
      if (n % 200 === 0) expect((await hitAs(abuser)).status).toBe(429);
    }
    expect((await hitAs(abuser)).status).toBe(429);
  });
});

describe("rate limit", () => {
  it("one address gets 60 clicks an hour, then 429", async () => {
    const token = issueReviewClickToken(SA, "req_1");
    for (let i = 0; i < 60; i++) expect((await click(token)).status).toBe(302);
    const res = await click(token);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
