import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { skewClockPastSlackCooldown } from "@/test/slack-cooldown-clock";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Breaker repros from the #449 review (scratchpad brk449b), adopted: queued
 * posts after a disconnect, the authz matrix with no URL in any response,
 * log or doc, the /slack/test cooldown, and POST `events` validation.
 * Real routes, real dispatch and consumer; the transport is faked.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async (uid: string) => ({
      customClaims: { status: uid === "inactive1" ? "disabled" : "active", agencyId: uid === "otheradmin" ? "ag2" : "ag1", agencyRole: null },
    }),
  }),
}));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: async () => ({ messageId: "m" }) }));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({ findMatchingSubscriptions: async () => [] }));
vi.mock("@/lib/push/events", () => ({ dispatchPushForWebhookEvent: async () => {} }));

const route = await import("@/app/api/sub-accounts/[id]/slack/route");
const testRoute = await import("@/app/api/sub-accounts/[id]/slack/test/route");
const { emitWebhookEvent } = await import("@/lib/api/webhooks/dispatch");

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";

const req = (sa: string, method: string, body?: unknown, uid = "admin1") =>
  new Request(`https://app.test/api/sub-accounts/${sa}/slack`, {
    method,
    headers: { "x-user-uid": uid },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (sa: string) => ({ params: Promise.resolve({ id: sa }) });
const { pastCooldown } = skewClockPastSlackCooldown();

async function connected(sa: string) {
  mem.seed(`subAccounts/${sa}`, { agencyId: "ag1" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/admin1`, { role: "admin", status: "active" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/collab1`, { role: "collaborator", status: "active" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/inactive1`, { role: "admin", status: "active" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/pending1`, { role: "admin", status: "invited" });
  mem.seed(`subAccounts/sa-other`, { agencyId: "ag2" });
  mem.seed(`subAccounts/sa-other/subAccountMembers/otheradmin`, { role: "admin", status: "active" });
  expect((await route.POST(req(sa, "POST", { webhookUrl: URL_A, events: ["contact.created"] }), ctx(sa))).status).toBe(200);
}
const emit = async (sa: string) => {
  await emitWebhookEvent({ subAccountId: sa, agencyId: "ag1", mode: "live", type: "contact.created", payload: { contact: { id: "c1", name: "Ann" } } });
  await flushAfterResponse();
};

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("REPRO 4 queued posts still go out after DELETE (disconnect)", async () => {
  await connected("sa-q");
  publicFetch.mockClear();
  // 4 events in a burst: lane spaces them 1 s apart
  const burst = Promise.all([emit("sa-q"), emit("sa-q"), emit("sa-q"), emit("sa-q")]);
  await vi.waitFor(() => expect(publicFetch.mock.calls.length).toBeGreaterThanOrEqual(1));
  expect((await route.DELETE(req("sa-q", "DELETE"), ctx("sa-q"))).status).toBe(200);
  const atDelete = publicFetch.mock.calls.length;
  await burst;
  expect(publicFetch.mock.calls.length, `posts after disconnect: ${publicFetch.mock.calls.length - atDelete}`).toBe(atDelete);
});

it("REPRO 5 authz matrix + no URL in responses/logs", async () => {
  await connected("sa-z");
  const calls = (uid: string) => [
    () => route.GET(req("sa-z", "GET", undefined, uid), ctx("sa-z")),
    () => route.POST(req("sa-z", "POST", { webhookUrl: URL_A }, uid), ctx("sa-z")),
    () => route.PATCH(req("sa-z", "PATCH", { includeMessagePreview: true }, uid), ctx("sa-z")),
    () => route.DELETE(req("sa-z", "DELETE", undefined, uid), ctx("sa-z")),
    () => testRoute.POST(req("sa-z", "POST", undefined, uid), ctx("sa-z")),
  ];
  for (const uid of ["collab1", "otheradmin", "pending1", "nobody", "inactive1"]) {
    for (const c of calls(uid)) {
      const r = await c();
      expect([401, 403, 404], `${uid}`).toContain(r.status);
    }
  }
  // state untouched
  expect(mem.read("subAccounts/sa-z/private/slack")?.webhookUrl).toBe(URL_A);
  expect((mem.read("subAccounts/sa-z")?.slackMeta as Record<string, unknown>).includeMessagePreview).toBe(false);
  // no auth header at all
  const r = await route.GET(new Request("https://app.test/x"), ctx("sa-z"));
  expect(r.status).toBe(401);
  // admin responses never contain the token
  for (const c of calls("admin1").slice(0, 3)) {
    const t = await (await c()).text();
    expect(t).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  }
  const t2 = await (await testRoute.POST(req("sa-z", "POST"), ctx("sa-z"))).text();
  expect(t2).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  // slack failure body echo / transport throw containing URL. Past the
  // test-button cooldown first, so this call really posts.
  publicFetch.mockRejectedValueOnce(new Error(`connect failed ${URL_A}`));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 6_000);
  let t3: Response;
  try {
    t3 = await testRoute.POST(req("sa-z", "POST"), ctx("sa-z"));
  } finally {
    vi.useRealTimers();
  }
  expect(t3.status).toBe(502);
  expect(await t3.text()).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  const logs = JSON.stringify([...(console.warn as never as { mock: { calls: unknown[] } }).mock.calls, ...(console.error as never as { mock: { calls: unknown[] } }).mock.calls]);
  expect(logs, "token leaked in logs").not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
  expect(JSON.stringify(mem.read("subAccounts/sa-z"))).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
});

it("REPRO 6 test endpoint has a 5 s cooldown: 15 clicks = 1 post, then one again after it", async () => {
  await connected("sa-t");
  pastCooldown();
  publicFetch.mockClear();
  const statuses: number[] = [];
  for (let i = 0; i < 15; i++) statuses.push((await testRoute.POST(req("sa-t", "POST"), ctx("sa-t"))).status);
  expect(publicFetch.mock.calls.length, "15 admin clicks -> 1 post").toBe(1);
  expect(statuses).toEqual([200, ...Array(14).fill(429)]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5_100);
  try {
    expect((await testRoute.POST(req("sa-t", "POST"), ctx("sa-t"))).status).toBe(200);
  } finally {
    vi.useRealTimers();
  }
  expect(publicFetch.mock.calls.length).toBe(2);
});

it("REPRO 7 POST with events:null / non-array silently disables everything", async () => {
  mem.seed("subAccounts/sa-e", { agencyId: "ag1" });
  mem.seed("subAccounts/sa-e/subAccountMembers/admin1", { role: "admin", status: "active" });
  for (const events of [null, "contact.created", { 0: "contact.created" }]) {
    const r = await route.POST(req("sa-e", "POST", { webhookUrl: URL_A, events }), ctx("sa-e"));
    expect(r.status, `events:${JSON.stringify(events)} should be 400, not accepted as 'no events'`).toBe(400);
  }
  expect(publicFetch).not.toHaveBeenCalled();
  expect(mem.read("subAccounts/sa-e/private/slack")).toBeUndefined();
});
