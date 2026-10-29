import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The Slack consumer through the real webhook dispatcher (`emitWebhookEvent`
 * → `dispatchSlackForWebhookEvent` → slack-service → `postSlackMessage`).
 * Only the transport (`publicFetch`, covered by ssrf-callers.test.ts) and the
 * delivery plumbing are faked. Each test uses its own sub-account: the hook
 * cache and the per-sub-account post lane are module state.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));
const publishCallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/automations/qstash", () => ({ publishCallback }));
vi.mock("@/lib/firestore/webhook-events", () => ({
  createEvent: async () => ({ id: "ev1" }),
  createDelivery: async () => ({ id: "dl1" }),
  updateDelivery: async () => {},
}));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({
  findMatchingSubscriptions: async () => [{ id: "sub1", url: "https://hook.test" }],
}));
vi.mock("@/lib/push/events", () => ({ dispatchPushForWebhookEvent: async () => {} }));

const { emitWebhookEvent } = await import("@/lib/api/webhooks/dispatch");
const { recordSlackResult } = await import("@/lib/server/slack-service");

const URL_A = "https://hooks.slack.com/services/T0001/B0001/aaaaaaaaaaaaaaaaaaaaaaaa";
const URL_B = "https://hooks.slack.com/services/T0001/B0002/bbbbbbbbbbbbbbbbbbbbbbbb";

function connect(sa: string, url = URL_A, events = ["contact.created"]) {
  mem.seed(`subAccounts/${sa}`, {
    agencyId: "ag1",
    slackMeta: { connected: true, events, needsReconnect: false, lastError: null, urlTail: url.slice(-6) },
  });
  mem.seed(`subAccounts/${sa}/private/slack`, { webhookUrl: url, connectedByUid: "u1" });
}

const emit = (sa: string, extra: Record<string, unknown> = {}) =>
  emitWebhookEvent({
    subAccountId: sa,
    agencyId: "ag1",
    mode: "live",
    type: "contact.created",
    payload: { contact: { id: "c1", name: "Ann" } },
    ...extra,
  });

const meta = (sa: string) => mem.read(`subAccounts/${sa}`)?.slackMeta as Record<string, unknown>;

beforeEach(() => {
  mem.clear();
  publicFetch.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("dispatch → Slack", () => {
  it("posts a ticked live event to the stored hook", async () => {
    connect("sa-post");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await emit("sa-post");
      await flushAfterResponse();
      // One 5 s deadline, and it is the signal publicFetch gets.
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(5_000);
      expect(publicFetch.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value);
    } finally {
      timeout.mockRestore();
    }
    expect(publicFetch).toHaveBeenCalledTimes(1);
    const [url, init] = publicFetch.mock.calls[0];
    expect(url).toBe(URL_A);
    expect(JSON.parse(init.body).text).toBe("New lead: Ann");
    // The deadline and the body cap are what make an unresponsive or
    // oversized answer harmless; both must reach publicFetch.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
    expect(init.maxBytes).toBe(4 * 1024);
  });

  it("an inbound message posts the first name only, unless the hook opts in to the text", async () => {
    const message = { contact_id: "c1", contact_name: "Ann Lee", channel: "sms", preview: "my id is 800101" };
    connect("sa-msg", URL_A, ["message.received"]);
    await emit("sa-msg", { type: "message.received", payload: { message } });
    await flushAfterResponse();
    expect(JSON.parse(publicFetch.mock.calls[0][1].body).text).toBe("New message from Ann");
    expect(publicFetch.mock.calls[0][1].body).not.toContain("800101");

    connect("sa-msg-on", URL_A, ["message.received"]);
    mem.seed("subAccounts/sa-msg-on", {
      ...mem.read("subAccounts/sa-msg-on"),
      slackMeta: { ...meta("sa-msg-on"), includeMessagePreview: true },
    });
    await emit("sa-msg-on", { type: "message.received", payload: { message } });
    await flushAfterResponse();
    expect(JSON.parse(publicFetch.mock.calls[1][1].body).text).toBe("Ann Lee replied on SMS — “my id is 800101”");
  });

  it("does not post test-mode events or events that aren't ticked", async () => {
    connect("sa-skip", URL_A, ["deal.won"]);
    await emit("sa-skip");
    await emit("sa-skip", { mode: "test", type: "deal.won" });
    await flushAfterResponse();
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("still schedules webhook deliveries when Slack's own reads throw", async () => {
    connect("sa-throw");
    const doc = vi.spyOn(mem.db, "doc").mockImplementation(() => {
      throw new Error("firestore down");
    });
    try {
      await emit("sa-throw");
      await flushAfterResponse();
    } finally {
      doc.mockRestore();
    }
    expect(publishCallback).toHaveBeenCalledWith(
      expect.objectContaining({ deduplicationId: "ev1_dl1", delaySeconds: 0 }),
    );
    expect(publicFetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[slack/events] dispatch failed", "firestore down");
  });

  it("schedules deliveries without waiting on a Slack post that never answers", async () => {
    connect("sa-hang");
    publicFetch.mockReturnValue(new Promise(() => {}));
    await emit("sa-hang");
    expect(publishCallback).toHaveBeenCalledWith(
      expect.objectContaining({ deduplicationId: "ev1_dl1" }),
    );
  });

  it("refuses a stored URL that isn't a Slack hook, even though it was stored", async () => {
    connect("sa-bad", "https://evil.test/services/T0001/B0001/aaaa");
    await emit("sa-bad");
    await flushAfterResponse();
    expect(publicFetch).not.toHaveBeenCalled();
  });
});

describe("revoked hooks", () => {
  it("a 404 marks the hook revoked, and the next event does not post", async () => {
    connect("sa-404");
    publicFetch.mockResolvedValue(new Response("no_service", { status: 404 }));
    await emit("sa-404");
    await flushAfterResponse();
    expect(meta("sa-404")).toMatchObject({ needsReconnect: true });
    expect(meta("sa-404").lastError).toMatch(/no longer accepts/);
    // Re-read (not served from a cache) both times: the revoked check
    // invalidates it, so this is the stored state talking.
    expect(publicFetch).toHaveBeenCalledTimes(1);
    await emit("sa-404");
    await flushAfterResponse();
    expect(publicFetch).toHaveBeenCalledTimes(1);
  });

  it("a 410 marks it revoked too; a 500 records the error but does not", async () => {
    connect("sa-410");
    publicFetch.mockResolvedValue(new Response("gone", { status: 410 }));
    await emit("sa-410");
    await flushAfterResponse();
    expect(meta("sa-410").needsReconnect).toBe(true);

    connect("sa-500");
    publicFetch.mockResolvedValue(new Response("oops", { status: 500 }));
    await emit("sa-500");
    await flushAfterResponse();
    expect(meta("sa-500")).toMatchObject({ needsReconnect: false, lastError: "Slack returned 500: oops" });
  });

  it("a revoke for a URL that has since been replaced does not flag the new one", async () => {
    connect("sa-swap", URL_B);
    await recordSlackResult("sa-swap", URL_A, { ok: false, revoked: true, error: "gone" });
    expect(meta("sa-swap")).toMatchObject({ needsReconnect: false, lastError: null });
    await recordSlackResult("sa-swap", URL_B, { ok: false, revoked: true, error: "gone" });
    expect(meta("sa-swap")).toMatchObject({ needsReconnect: true, lastError: "gone" });
  });
});
