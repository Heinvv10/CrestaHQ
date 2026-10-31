import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Re-break repros (#449 on fec1dc43, brk449d), adopted: the test cooldown
 * has no URL exemption to bypass (delete + re-POST, alternating URLs,
 * concurrent new-URL POSTs), a failed connect releases it, a revoked hook's
 * backlog stops, untick/re-tick and preview flaps, and redaction with and
 * without the stored URL. Real routes, dispatch and consumer.
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
const { emitWebhookEvent } = await import("@/lib/api/webhooks/dispatch");
const { redactSlackUrls } = await import("@/lib/slack/client");

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";
const URL_B = "https://hooks.slack.com/services/T0001/B0002/bbbbbbbbbbbbbbbbbbbbbbbb";
const req = (method: string, body?: unknown) =>
  new Request(`https://app.test/x`, { method, headers: { "x-user-uid": "admin1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (sa: string) => ({ params: Promise.resolve({ id: sa }) });
function seed(sa: string) {
  mem.seed(`subAccounts/${sa}`, { agencyId: "ag1" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/admin1`, { role: "admin", status: "active" });
}
async function connected(sa: string) {
  seed(sa);
  expect((await route.POST(req("POST", { webhookUrl: URL_A, events: ["contact.created"] }), ctx(sa))).status).toBe(200);
}
const emit = async (sa: string, name = "Ann") => {
  await emitWebhookEvent({ subAccountId: sa, agencyId: "ag1", mode: "live", type: "contact.created", payload: { contact: { id: "c1", name } } });
  await flushAfterResponse();
};
const leadPosts = () => publicFetch.mock.calls.filter(([, i]) => /New lead/.test(JSON.parse(i.body).text)).length;
const connectedMsgs = () => publicFetch.mock.calls.filter(([, i]) => /is connected to this channel/.test(JSON.parse(i.body).text)).length;

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockImplementation(async () => new Response("ok", { status: 200 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cooldown exemption", () => {
  it("G2 DELETE + POST same URL loop floods the channel", async () => {
    seed("sa-g2");
    publicFetch.mockClear();
    for (let i = 0; i < 10; i++) {
      await route.POST(req("POST", { webhookUrl: URL_A }), ctx("sa-g2"));
      await route.DELETE(req("DELETE"), ctx("sa-g2"));
    }
    expect(connectedMsgs(), "10 connect cycles -> test posts").toBeLessThanOrEqual(2);
  });
  it("G3 alternating two URLs floods", async () => {
    seed("sa-g3");
    publicFetch.mockClear();
    for (let i = 0; i < 10; i++) await route.POST(req("POST", { webhookUrl: i % 2 ? URL_A : URL_B }), ctx("sa-g3"));
    expect(connectedMsgs()).toBeLessThanOrEqual(2);
  });
  it("G4 concurrent connects with a new URL all post", async () => {
    await connected("sa-g4");
    publicFetch.mockClear();
    await Promise.all(Array.from({ length: 10 }, () => route.POST(req("POST", { webhookUrl: URL_B }), ctx("sa-g4"))));
    expect(connectedMsgs()).toBeLessThanOrEqual(2);
  });
  it("G4b failed connect (bad hook) does not burn the window for the fixed URL", async () => {
    seed("sa-g4b");
    publicFetch.mockResolvedValueOnce(new Response("no_service", { status: 404 }));
    expect((await route.POST(req("POST", { webhookUrl: URL_A }), ctx("sa-g4b"))).status).toBe(502);
    expect((await route.POST(req("POST", { webhookUrl: URL_B }), ctx("sa-g4b"))).status).toBe(200);
    expect((await route.POST(req("POST", { webhookUrl: URL_B }), ctx("sa-g4b"))).status, "re-save same url right away").toBe(429);
  });
});

describe("queue skip comparisons", () => {
  it("G1 revoked hook with a backlog: how many dead-hook posts?", async () => {
    await connected("sa-g1");
    publicFetch.mockClear();
    publicFetch.mockImplementation(async () => new Response("no_service", { status: 404 }));
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => emit("sa-g1", `N${n}`)));
    expect(publicFetch.mock.calls.length, "posts to a hook that already 404'd").toBeLessThanOrEqual(2);
  });
  it("G5 untick and re-tick inside the window posts once each (no doubling, no loss)", async () => {
    await connected("sa-g5");
    publicFetch.mockClear();
    const burst = Promise.all([emit("sa-g5", "A"), emit("sa-g5", "B"), emit("sa-g5", "C")]);
    await vi.waitFor(() => expect(leadPosts()).toBeGreaterThanOrEqual(1));
    await route.PATCH(req("PATCH", { events: [] }), ctx("sa-g5"));
    await route.PATCH(req("PATCH", { events: ["contact.created"] }), ctx("sa-g5"));
    await burst;
    expect(leadPosts()).toBe(3);
    const names = publicFetch.mock.calls.map(([, i]) => JSON.parse(i.body).text);
    expect(new Set(names).size).toBe(names.length);
  });
  it("G5b untick only: remaining queued are skipped, none sent after", async () => {
    await connected("sa-g5b");
    publicFetch.mockClear();
    const burst = Promise.all([emit("sa-g5b", "A"), emit("sa-g5b", "B"), emit("sa-g5b", "C")]);
    await vi.waitFor(() => expect(leadPosts()).toBeGreaterThanOrEqual(1));
    await route.PATCH(req("PATCH", { events: [] }), ctx("sa-g5b"));
    await burst;
    expect(leadPosts()).toBe(1);
  });
  // G6 (preview OFF->ON mid-burst drops the queued preview-less posts) is
  // not adopted: it fails in the safe direction. A preview change skips
  // queued posts by design, so no text posts under a choice it wasn't built
  // for (G7).
  it("G7 preview ON->OFF->ON flap: a message built with preview ON, sent while ON, but OFF existed between (no leak while OFF)", async () => {
    await connected("sa-g7");
    await route.PATCH(req("PATCH", { includeMessagePreview: true }), ctx("sa-g7"));
    publicFetch.mockClear();
    const msg = (n: string) => emitWebhookEvent({ subAccountId: "sa-g7", agencyId: "ag1", mode: "live", type: "message.received" as never, payload: { message: { contact_id: "c", contact_name: "Ann Lee", channel: "sms", preview: `SECRET-${n}` } } });
    await route.PATCH(req("PATCH", { events: ["message.received"] }), ctx("sa-g7"));
    await Promise.all([msg("1"), msg("2"), msg("3")]);
    await vi.waitFor(() => expect(publicFetch.mock.calls.length).toBeGreaterThanOrEqual(1));
    await route.PATCH(req("PATCH", { includeMessagePreview: false }), ctx("sa-g7"));
    const afterOff = publicFetch.mock.calls.length;
    await flushAfterResponse();
    const later = publicFetch.mock.calls.slice(afterOff).map(([, i]) => i.body).join("");
    expect(later).not.toContain("SECRET");
  });
});

describe("redaction", () => {
  const T = "aaaaaaaaaaaaaaaaaaaaaaaa";
  it.each([
    ["plain", `x ${URL_A} y`],
    ["encoded", encodeURIComponent(URL_A)],
    ["path only", `GET /services/T0001/B0001/${T}`],
    ["newline split", URL_A.replace("/B0001", "\n/B0001")],
    ["space split", URL_A.replace("/B0001", " /B0001")],
    ["token only", `tok ${T}`],
    ["double encoded", encodeURIComponent(encodeURIComponent(URL_A))],
    ["json escaped slashes", JSON.stringify(URL_A).replace(/\//g, "\\/")],
    ["lowercase-case-mangled token", `tok ${T.toUpperCase()}`],
  ])("with url param: %s", (_n, m) => {
    expect(redactSlackUrls(m, URL_A).toLowerCase()).not.toContain(T);
  });
  it.each([
    ["plain", `x ${URL_A} y`],
    ["encoded", encodeURIComponent(URL_A)],
    ["path only", `GET /services/T0001/B0001/${T}`],
    ["newline split", URL_A.replace("/B0001", "\n/B0001")],
    ["json escaped slashes", JSON.stringify(URL_A).replace(/\//g, "\\/")],
  ])("without url param (route handlers): %s", (_n, m) => {
    expect(redactSlackUrls(m)).not.toContain(T);
  });
});
