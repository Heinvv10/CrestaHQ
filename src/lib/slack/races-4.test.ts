import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Re-break repro H1 (#449 on 83b13e4d, brk449e), adopted: a slow test post
 * that fails after its window ran out must not release the newer claim made
 * meanwhile (release is compare-and-delete). Real routes; transport faked.
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

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";
const req = (method: string, body?: unknown) =>
  new Request(`https://app.test/x`, { method, headers: { "x-user-uid": "admin1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (sa: string) => ({ params: Promise.resolve({ id: sa }) });
function seed(sa: string) {
  mem.seed(`subAccounts/${sa}`, { agencyId: "ag1" });
  mem.seed(`subAccounts/${sa}/subAccountMembers/admin1`, { role: "admin", status: "active" });
}
const posts = () => publicFetch.mock.calls.length;

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockImplementation(async () => new Response("ok", { status: 200 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("claim / release", () => {
  it("H1 stale failure releases a NEWER claim (release is not compare-and-delete)", async () => {
    seed("sa-h1");
    expect((await route.POST(req("POST", { webhookUrl: URL_A }), ctx("sa-h1"))).status).toBe(200);
    // A: a test post that hangs, then fails after the window has passed
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6_000);
      let failA!: () => void;
      publicFetch.mockImplementationOnce(() => new Promise((_r, rej) => { failA = () => rej(new Error("timeout")); }));
      const a = testRoute.POST(req("POST"), ctx("sa-h1")); // claims at T+6s
      await vi.waitFor(() => expect(failA).toBeTypeOf("function"));
      vi.setSystemTime(Date.now() + 5_100); // window over while A still in flight
      const b = await testRoute.POST(req("POST"), ctx("sa-h1")); // B claims
      expect(b.status).toBe(200);
      failA(); // A finally fails -> releases the slot (B's claim)
      await a;
      const before = posts();
      const c = await testRoute.POST(req("POST"), ctx("sa-h1")); // immediately after B
      expect(c.status, "C right after B must be 429").toBe(429);
      expect(posts()).toBe(before);
    } finally { vi.useRealTimers(); }
  });
});
