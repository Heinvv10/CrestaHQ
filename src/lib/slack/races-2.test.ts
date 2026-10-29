import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { skewClockPastSlackCooldown } from "@/test/slack-cooldown-clock";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Re-break repros (#449 on 5afc15f2, brk449c), adopted, plus the changes that
 * MUST still skip a queued post. A queued post re-reads the hook just before
 * sending and is skipped only when the URL changed, its event was unticked or
 * the preview choice changed; a harmless settings action posts as queued.
 * Real routes, dispatch and consumer; the transport is faked.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1", agencyRole: null } }) }),
}));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: async () => ({ messageId: "m" }) }));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({ findMatchingSubscriptions: async () => [] }));
vi.mock("@/lib/push/events", () => ({ dispatchPushForWebhookEvent: async () => {} }));

const route = await import("@/app/api/sub-accounts/[id]/slack/route");
const testRoute = await import("@/app/api/sub-accounts/[id]/slack/test/route");
const { emitWebhookEvent } = await import("@/lib/api/webhooks/dispatch");
const { redactSlackUrls } = await import("@/lib/slack/client");

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";
const req = (sa: string, method: string, body?: unknown | string) =>
  new Request(`https://app.test/x`, { method, headers: { "x-user-uid": "admin1" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
const ctx = (sa: string) => ({ params: Promise.resolve({ id: sa }) });
const { pastCooldown } = skewClockPastSlackCooldown();
async function connected(sa: string) {
  mem.seed(`subAccounts/${sa}`, { agencyId: "ag1" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/admin1`, { role: "admin", status: "active" });
  expect((await route.POST(req(sa, "POST", { webhookUrl: URL_A, events: ["contact.created"] }), ctx(sa))).status).toBe(200);
}
const emit = async (sa: string, name = "Ann") => {
  await emitWebhookEvent({ subAccountId: sa, agencyId: "ag1", mode: "live", type: "contact.created", payload: { contact: { id: "c1", name } } });
  await flushAfterResponse();
};
const eventPosts = () => publicFetch.mock.calls.filter(([, i]) => /New lead/.test(JSON.parse(i.body).text)).length;

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("attack the fixes", () => {
  it("F1 a harmless Send-test click mid-burst must not drop queued notifications", async () => {
    await connected("sa-a");
    publicFetch.mockClear();
    const burst = Promise.all([emit("sa-a", "A"), emit("sa-a", "B"), emit("sa-a", "C"), emit("sa-a", "D")]);
    await vi.waitFor(() => expect(eventPosts()).toBeGreaterThanOrEqual(1));
    await testRoute.POST(req("sa-a", "POST"), ctx("sa-a")); // config unchanged
    await burst;
    expect(eventPosts(), "4 events, config unchanged, expected 4 posts").toBe(4);
  });
  it("F2 PATCH that changes nothing relevant (preview flag) mid-burst drops queued events", async () => {
    await connected("sa-b");
    publicFetch.mockClear();
    const burst = Promise.all([emit("sa-b", "A"), emit("sa-b", "B"), emit("sa-b", "C")]);
    await vi.waitFor(() => expect(eventPosts()).toBeGreaterThanOrEqual(1));
    await route.PATCH(req("sa-b", "PATCH", { events: ["contact.created", "deal.won"] }), ctx("sa-b")); // contact.created still ticked
    await burst;
    expect(eventPosts(), "contact.created still ticked: 3 posts").toBe(3);
  });
  it("F3 POST /slack (reconnect) shares the test cooldown: 10 re-saves in the window = 1 post", async () => {
    await connected("sa-c");
    pastCooldown();
    publicFetch.mockClear();
    for (let i = 0; i < 10; i++) await route.POST(req("sa-c", "POST", { webhookUrl: URL_A }), ctx("sa-c"));
    expect(publicFetch.mock.calls.length, "10 reconnects within the window = 1 channel post").toBe(1);
  });
  it("F4 concurrent test clicks: exactly one post", async () => {
    await connected("sa-d");
    pastCooldown();
    publicFetch.mockClear();
    const rs = await Promise.all(Array.from({ length: 10 }, () => testRoute.POST(req("sa-d", "POST"), ctx("sa-d"))));
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(publicFetch.mock.calls.length).toBe(1);
  });
  it("F5 a refused test does not start the window; connect does (it posted), so a test waits it out", async () => {
    mem.seed("subAccounts/sa-e", { agencyId: "ag1" });
    mem.seed("subAccounts/sa-e/subAccountMembers/admin1", { role: "admin", status: "active" });
    expect((await testRoute.POST(req("sa-e", "POST"), ctx("sa-e"))).status).toBe(400);
    expect((await route.POST(req("sa-e", "POST", { webhookUrl: URL_A }), ctx("sa-e"))).status, "connect after a refused test").toBe(200);
    expect((await testRoute.POST(req("sa-e", "POST"), ctx("sa-e"))).status, "test right after connect").toBe(429);
    pastCooldown();
    expect((await testRoute.POST(req("sa-e", "POST"), ctx("sa-e"))).status).toBe(200);
  });
  it.each([["number", "5"], ["string", '"x"'], ["null", "null"], ["array", "[]"]])("F6 POST body %s -> 400 not 500/throw", async (_n, raw) => {
    mem.seed("subAccounts/sa-f", { agencyId: "ag1" });
    mem.seed("subAccounts/sa-f/subAccountMembers/admin1", { role: "admin", status: "active" });
    let status = 0;
    try { status = (await route.POST(req("sa-f", "POST", raw), ctx("sa-f"))).status; } catch { status = -1; }
    expect(status, `body ${raw}`).toBe(400);
  });
  it.each([["number", "5"], ["null", "null"]])("F6b PATCH body %s -> 400", async (_n, raw) => {
    await connected("sa-g");
    let status = 0;
    try { status = (await route.PATCH(req("sa-g", "PATCH", raw), ctx("sa-g"))).status; } catch { status = -1; }
    expect(status, `body ${raw}`).toBe(400);
  });
  it("F7 invalid stored URL: flagged once, not a write storm; test reports it", async () => {
    await connected("sa-h");
    mem.seed("subAccounts/sa-h/private/slack", { webhookUrl: "https://evil.test/services/T/B/c", connectedByUid: "u" });
    await emit("sa-h"); await emit("sa-h");
    const m = mem.read("subAccounts/sa-h")?.slackMeta as Record<string, unknown>;
    expect(m.needsReconnect).toBe(true);
    expect(String(m.lastError)).toMatch(/not a Slack/);
    expect(eventPosts()).toBe(0);
    expect(JSON.stringify(m)).not.toContain("evil.test");
  });
  it("F8 two sub-accounts: invalidating one must not skip the other's queue", async () => {
    await connected("sa-i1"); await connected("sa-i2");
    publicFetch.mockClear();
    const burst = Promise.all([emit("sa-i2", "A"), emit("sa-i2", "B"), emit("sa-i2", "C")]);
    await vi.waitFor(() => expect(eventPosts()).toBeGreaterThanOrEqual(1));
    await route.DELETE(req("sa-i1", "DELETE"), ctx("sa-i1"));
    await burst;
    expect(eventPosts()).toBe(3);
  });
});

describe("mid-burst changes that do skip queued posts", () => {
  const URL_B = "https://hooks.slack.com/services/T0001/B0002/bbbbbbbbbbbbbbbbbbbbbbbb";
  const postsTo = (url: string) =>
    publicFetch.mock.calls.filter(([u, i]) => u === url && /New lead/.test(JSON.parse(i.body).text)).length;

  async function midBurst(sa: string, change: () => Promise<unknown>) {
    await connected(sa);
    publicFetch.mockClear();
    const burst = Promise.all([emit(sa, "A"), emit(sa, "B"), emit(sa, "C")]);
    await vi.waitFor(() => expect(eventPosts()).toBeGreaterThanOrEqual(1));
    const before = eventPosts();
    await change();
    await burst;
    return before;
  }

  it("a reconnect to a new URL: nothing more goes to the old one, and nothing queued goes to the new one", async () => {
    const before = await midBurst("sa-j", async () => {
      pastCooldown();
      expect((await route.POST(req("sa-j", "POST", { webhookUrl: URL_B }), ctx("sa-j"))).status).toBe(200);
    });
    expect(postsTo(URL_A)).toBe(before);
    expect(postsTo(URL_B)).toBe(0);
  });

  it("a PATCH that unticks the event", async () => {
    const before = await midBurst("sa-k", () =>
      route.PATCH(req("sa-k", "PATCH", { events: ["deal.won"] }), ctx("sa-k")),
    );
    expect(eventPosts()).toBe(before);
  });

  it("a PATCH that changes the preview choice", async () => {
    const before = await midBurst("sa-l", () =>
      route.PATCH(req("sa-l", "PATCH", { includeMessagePreview: true }), ctx("sa-l")),
    );
    expect(eventPosts()).toBe(before);
  });
});

describe("redaction misses", () => {
  const T = "aaaaaaaaaaaaaaaaaaaaaaaa";
  it.each([
    ["plain", `x ${URL_A} y`],
    ["quoted json", JSON.stringify({ u: URL_A })],
    ["upper host", URL_A.replace("hooks.slack.com", "HOOKS.SLACK.COM")],
    ["url-encoded", encodeURIComponent(URL_A)],
    ["path only", "POST /services/T0001/B0001/" + T + " HTTP/1.1"],
    ["token only", "bad token " + T],
    ["http scheme", URL_A.replace("https", "http")],
    ["trailing dot host", URL_A.replace("slack.com", "slack.com.")],
    ["newline split", URL_A.replace("/B0001", "\n/B0001")],
  ])("%s", (_n, msg) => {
    expect(redactSlackUrls(msg, URL_A)).not.toContain(T);
  });
});
