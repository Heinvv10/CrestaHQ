import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The consumer caches a sub-account's hook for a minute. A change made in
 * Settings must reach the next event on this instance: emit (warms the
 * cache), change the hook through the real route, emit again. Real routes,
 * real `emitWebhookEvent`, real Slack consumer; the transport is faked.
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
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: async () => ({ messageId: "m" }) }));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({ findMatchingSubscriptions: async () => [] }));
vi.mock("@/lib/push/events", () => ({ dispatchPushForWebhookEvent: async () => {} }));

const route = await import("@/app/api/sub-accounts/[id]/slack/route");
const { emitWebhookEvent } = await import("@/lib/api/webhooks/dispatch");

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";
const URL_B = "https://hooks.slack.com/services/T0001/B0002/bbbbbbbbbbbbbbbbbbbbbbbb";

const req = (sa: string, method: string, body?: unknown) =>
  new Request(`https://app.test/api/sub-accounts/${sa}/slack`, {
    method,
    headers: { "x-user-uid": "admin1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (sa: string) => ({ params: Promise.resolve({ id: sa }) });

async function connected(sa: string) {
  mem.seed(`subAccounts/${sa}`, { agencyId: "ag1" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/admin1`, { role: "admin", status: "active" });
  expect((await route.POST(req(sa, "POST", { webhookUrl: URL_A, events: ["contact.created"] }), ctx(sa))).status).toBe(200);
}

async function emit(sa: string) {
  await emitWebhookEvent({
    subAccountId: sa, agencyId: "ag1", mode: "live", type: "contact.created",
    payload: { contact: { id: "c1", name: "Ann" } },
  });
  await flushAfterResponse();
}

/** URLs of event posts (the connect route's own test post excluded). */
const eventPosts = () =>
  publicFetch.mock.calls
    .filter(([, init]) => JSON.parse(init.body).text === "New lead: Ann")
    .map(([url]) => url as string);

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

it("disconnect: the next event does not post", async () => {
  await connected("sa-del");
  await emit("sa-del");
  expect((await route.DELETE(req("sa-del", "DELETE"), ctx("sa-del"))).status).toBe(200);
  await emit("sa-del");
  expect(eventPosts()).toEqual([URL_A]);
});

it("reconnect with a new URL: the next event posts to the new one", async () => {
  await connected("sa-swap");
  await emit("sa-swap");
  expect((await route.POST(req("sa-swap", "POST", { webhookUrl: URL_B }), ctx("sa-swap"))).status).toBe(200);
  await emit("sa-swap");
  expect(eventPosts()).toEqual([URL_A, URL_B]);
});

it("PATCH that unticks the event: the next event does not post", async () => {
  await connected("sa-patch");
  await emit("sa-patch");
  expect((await route.PATCH(req("sa-patch", "PATCH", { events: ["deal.won"] }), ctx("sa-patch"))).status).toBe(200);
  await emit("sa-patch");
  expect(eventPosts()).toEqual([URL_A]);
});
