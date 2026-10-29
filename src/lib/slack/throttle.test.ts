import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Slack takes about one post a second per hook. Posts for one sub-account are
 * spaced through a per-instance lane, and once 30 are waiting the rest are
 * dropped (a bulk import must not queue hundreds). Through the real
 * `emitWebhookEvent` and consumer; the transport is faked.
 *
 * Order matters: the last test leaves its lane blocked on a post that never
 * answers, so nothing after it may flush.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: async () => ({ messageId: "m" }) }));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({ findMatchingSubscriptions: async () => [] }));
vi.mock("@/lib/push/events", () => ({ dispatchPushForWebhookEvent: async () => {} }));

const { emitWebhookEvent } = await import("@/lib/api/webhooks/dispatch");

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";

function connect(sa: string) {
  mem.seed(`subAccounts/${sa}`, {
    agencyId: "ag1",
    slackMeta: { connected: true, events: ["contact.created"], needsReconnect: false, lastError: null },
  });
  mem.seed(`subAccounts/${sa}/private/slack`, { webhookUrl: URL_A, connectedByUid: "u1" });
}

const emit = (sa: string) =>
  emitWebhookEvent({
    subAccountId: sa, agencyId: "ag1", mode: "live", type: "contact.created",
    payload: { contact: { id: "c1", name: "Ann" } },
  });

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
beforeEach(() => {
  mem.clear();
  publicFetch.mockReset();
  warn.mockClear();
});

it("spaces posts for one sub-account about a second apart", async () => {
  connect("sa-gap");
  const at: number[] = [];
  publicFetch.mockImplementation(async () => {
    at.push(Date.now());
    return new Response("ok", { status: 200 });
  });
  await emit("sa-gap");
  await emit("sa-gap");
  await emit("sa-gap");
  await flushAfterResponse();
  expect(at).toHaveLength(3);
  expect(at[1] - at[0]).toBeGreaterThanOrEqual(950);
  expect(at[2] - at[1]).toBeGreaterThanOrEqual(950);
});

it("drops posts beyond 30 waiting, with a log line, and never sends them", async () => {
  connect("sa-q");
  publicFetch.mockReturnValue(new Promise(() => {}));
  for (let i = 0; i < 31; i++) await emit("sa-q");
  const dropped = () =>
    warn.mock.calls.filter((c) => c[0] === "[slack/events] queue full for sa-q, dropping post").length;
  await vi.waitFor(() => expect(dropped()).toBe(1));
  expect(publicFetch).toHaveBeenCalledTimes(1);
});
