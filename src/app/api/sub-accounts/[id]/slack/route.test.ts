import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { skewClockPastSlackCooldown } from "@/test/slack-cooldown-clock";

/**
 * Slack settings routes with the real `requireSubAccountAdmin` (claims and
 * membership read from the in-memory store) and the real slack-service. Only
 * the transport (`publicFetch`) is faked.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1", agencyRole: null } }),
  }),
}));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const route = await import("./route");
const testRoute = await import("./test/route");

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaa";

const ctx = (id = "sa1") => ({ params: Promise.resolve({ id }) });
const { pastCooldown } = skewClockPastSlackCooldown();
const req = (method: string, body?: unknown, uid = "admin1") =>
  new Request("https://app.test/api/sub-accounts/sa1/slack", {
    method,
    headers: { "x-user-uid": uid },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { role: "admin", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/member1", { role: "member", status: "active" });
  publicFetch.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
});

async function connect() {
  const res = await route.POST(req("POST", { webhookUrl: URL_A, channelLabel: "#sales" }), ctx());
  expect(res.status).toBe(200);
  return res;
}

describe("connect", () => {
  it("test-posts, stores the URL privately and only display meta on the sub doc", async () => {
    const res = await connect();
    expect(publicFetch).toHaveBeenCalledWith(URL_A, expect.objectContaining({ method: "POST" }));
    expect(mem.read("subAccounts/sa1/private/slack")).toMatchObject({ webhookUrl: URL_A, connectedByUid: "admin1" });
    const meta = mem.read("subAccounts/sa1")!.slackMeta as Record<string, unknown>;
    expect(meta).toMatchObject({ connected: true, channelLabel: "#sales", urlTail: "aaaa", includeMessagePreview: false });
    expect(JSON.stringify(meta)).not.toContain(TOKEN);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("stores no webhook URL in the channel label, even a different hook's", async () => {
    const other = "https://hooks.slack.com/services/T0002/B0002/bbbbbbbbbbbbbbbbbbbbbbbb";
    for (const channelLabel of [URL_A, other, `#sales ${URL_A}`]) {
      const res = await route.POST(req("POST", { webhookUrl: URL_A, channelLabel }), ctx());
      expect(res.status).toBe(200);
      const meta = JSON.stringify(mem.read("subAccounts/sa1")!.slackMeta);
      expect(meta).not.toContain("bbbbbbbb");
      expect(meta).not.toContain("aaaaaaaa");
      expect(meta).not.toContain("hooks.slack.com");
      pastCooldown();
    }
  });

  it.each([
    "https://hooks.slack.com.evil.test/services/T0001/B0001/aaaa",
    "http://hooks.slack.com/services/T0001/B0001/aaaa",
    "https://evil.test/services/T0001/B0001/aaaa",
    "https://hooks.slack.com:8443/services/T0001/B0001/aaaa",
    `${URL_A}${"a".repeat(400)}`,
  ])("refuses %s without posting or storing", async (webhookUrl) => {
    const res = await route.POST(req("POST", { webhookUrl }), ctx());
    expect(res.status).toBe(400);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1/private/slack")).toBeUndefined();
  });

  it("does not store a URL whose test post Slack refuses", async () => {
    publicFetch.mockResolvedValue(new Response("invalid_token", { status: 403 }));
    const res = await route.POST(req("POST", { webhookUrl: URL_A }), ctx());
    expect(res.status).toBe(502);
    expect(mem.read("subAccounts/sa1/private/slack")).toBeUndefined();
  });
});

describe("GET", () => {
  it("never returns the URL, only its tail", async () => {
    await connect();
    const res = await route.GET(req("GET"), ctx());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("hooks.slack.com");
    expect(JSON.parse(text).config).toMatchObject({ connected: true, urlTail: "aaaa", includeMessagePreview: false });
  });
});

describe("authz", () => {
  it.each([
    ["GET", () => route.GET(req("GET", undefined, "member1"), ctx())],
    ["POST", () => route.POST(req("POST", { webhookUrl: URL_A }, "member1"), ctx())],
    ["PATCH", () => route.PATCH(req("PATCH", { events: [] }, "member1"), ctx())],
    ["DELETE", () => route.DELETE(req("DELETE", undefined, "member1"), ctx())],
    ["test POST", () => testRoute.POST(req("POST", undefined, "member1"), ctx())],
  ])("a non-admin member gets 403 on %s and nothing is posted", async (_m, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1/private/slack")).toBeUndefined();
  });

  it("an id that is a path is 404 before any read", async () => {
    const get = vi.spyOn(mem.db, "doc");
    const res = await route.GET(req("GET"), ctx("sa1/private/slack"));
    expect(res.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });
});

describe("events, test and disconnect", () => {
  it("PATCH keeps only known events", async () => {
    await connect();
    const res = await route.PATCH(req("PATCH", { events: ["deal.won", "nope", "deal.won"] }), ctx());
    expect(res.status).toBe(200);
    expect((mem.read("subAccounts/sa1")!.slackMeta as { events: string[] }).events).toEqual(["deal.won"]);
  });

  it("PATCH sets includeMessagePreview, refuses a non-boolean, and a reconnect keeps it", async () => {
    await connect();
    const on = await route.PATCH(req("PATCH", { includeMessagePreview: true }), ctx());
    expect(on.status).toBe(200);
    expect((await on.json()).config).toMatchObject({ includeMessagePreview: true, events: expect.any(Array) });
    expect((await route.PATCH(req("PATCH", { includeMessagePreview: "yes" }), ctx())).status).toBe(400);
    expect((await route.PATCH(req("PATCH", {}), ctx())).status).toBe(400);
    pastCooldown();
    await connect();
    expect((mem.read("subAccounts/sa1")!.slackMeta as Record<string, unknown>).includeMessagePreview).toBe(true);
    await route.DELETE(req("DELETE"), ctx());
    pastCooldown();
    await connect();
    expect((mem.read("subAccounts/sa1")!.slackMeta as Record<string, unknown>).includeMessagePreview).toBe(false);
  });

  it("a test post that fails releases the cooldown: a fixed hook can be retried at once", async () => {
    await connect();
    pastCooldown();
    publicFetch.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    expect((await testRoute.POST(req("POST"), ctx())).status).toBe(502);
    expect((await testRoute.POST(req("POST"), ctx())).status).toBe(200);
    expect((await testRoute.POST(req("POST"), ctx())).status).toBe(429);
  });

  it("an expected refusal (SlackError) never reads the stored URL", async () => {
    mem.seed("subAccounts/sa1/private/slack", { webhookUrl: URL_A });
    const doc = vi.spyOn(mem.db, "doc");
    try {
      // Not connected: updateSlackSettings refuses with a SlackError.
      expect((await route.PATCH(req("PATCH", { events: [] }), ctx())).status).toBe(400);
      expect(doc.mock.calls.map(([p]) => p)).not.toContain("subAccounts/sa1/private/slack");
    } finally {
      doc.mockRestore();
    }
  });

  it("an unexpected route error is logged with the stored URL's secret redacted", async () => {
    const short = "https://hooks.slack.com/services/T1/B1/shortsecret1";
    mem.seed("subAccounts/sa1", { agencyId: "ag1", slackMeta: { connected: true, events: [], needsReconnect: false } });
    mem.seed("subAccounts/sa1/private/slack", { webhookUrl: short });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const tx = vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("write failed near shortsecret1"));
    try {
      expect((await route.PATCH(req("PATCH", { events: [] }), ctx())).status).toBe(500);
    } finally {
      tx.mockRestore();
    }
    expect(error).toHaveBeenCalledWith("[slack] route failed", "write failed near [slack-url]");
  });

  it("a stored URL that isn't a Slack hook: test says reconnect, and the card is flagged", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", slackMeta: { connected: true, events: [], needsReconnect: false } });
    mem.seed("subAccounts/sa1/private/slack", { webhookUrl: "https://evil.test/services/T0001/B0001/aaaa" });
    const res = await testRoute.POST(req("POST"), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Reconnect with a new one/);
    expect(publicFetch).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1")!.slackMeta).toMatchObject({
      needsReconnect: true,
      lastError: expect.stringMatching(/not a Slack Incoming Webhook URL/),
    });
  });

  it("DELETE removes the URL and clears the meta to null", async () => {
    await connect();
    const res = await route.DELETE(req("DELETE"), ctx());
    expect(res.status).toBe(200);
    expect(mem.read("subAccounts/sa1/private/slack")).toBeUndefined();
    expect(mem.read("subAccounts/sa1")!.slackMeta).toBeNull();
    const get = await (await route.GET(req("GET"), ctx())).json();
    expect(get.config).toMatchObject({ connected: false, urlTail: null });
  });
});
