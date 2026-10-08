import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/automations/prospecting/mystery-shop — the 24 h timer. The QStash
 * signature is verified for REAL (minted as QStash does, bound to this URL);
 * Firestore is the in-memory store.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const publish = vi.fn();
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...(await orig<typeof import("@/lib/automations/qstash")>()),
  publishCallback: (...a: unknown[]) => publish(...a),
}));

const KEY = "sig_test_current_key_for_mystery_shops";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_mystery_shops";

const { signQStashBody } = await import("../../../../../../e2e/lib/qstash");
const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/automations/prospecting/mystery-shop";
const body = (shopId = "s1") => JSON.stringify({ shopId });
const DAY = 24 * 3600_000;

function call(b = body(), signature: string | null = signQStashBody(URL_, b)) {
  const headers: Record<string, string> = signature ? { "upstash-signature": signature } : {};
  return POST(new Request(URL_, { method: "POST", headers, body: b }));
}
const seed = (extra: Record<string, unknown> = {}) =>
  mem.seed("mysteryShops/s1", {
    subAccountId: "sa1", channel: "call", status: "sent", sentAt: new Date(Date.now() - DAY - 31 * 60_000),
    respondedAt: null, ...extra,
  });
const status = () => mem.read("mysteryShops/s1")?.status;

beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  publish.mockReset().mockResolvedValue({ messageId: "m2" });
  mem.clear();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the door", () => {
  it("refuses an unsigned call, or one signed for another route, and changes nothing", async () => {
    seed();
    expect((await call(body(), null)).status).toBe(401);
    expect((await call(body(), signQStashBody("http://127.0.0.1:3100/api/automations/prospecting/report", body()))).status).toBe(401);
    expect(status()).toBe("sent");
  });

  it("answers 400 for a malformed body", async () => {
    expect((await call(JSON.stringify({ shopId: "a/b" }))).status).toBe(400);
    expect((await call("{nope")).status).toBe(400);
  });
});

describe("the timer", () => {
  it("turns a sent shop with no response into missed", async () => {
    seed();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "missed" });
    expect(status()).toBe("missed");
  });

  it("is idempotent: a second delivery is a 200 no-op", async () => {
    seed();
    await call();
    const again = await call();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, status: "missed" });
    expect(status()).toBe("missed");
  });

  it("leaves a responded shop alone", async () => {
    seed({ status: "responded", respondedAt: new Date(), responseMs: 1000 });
    expect(await (await call()).json()).toEqual({ ok: true, status: "responded" });
    expect(mem.read("mysteryShops/s1")).toMatchObject({ status: "responded", responseMs: 1000 });
  });

  it("an early delivery (inside the window) does not settle the shop", async () => {
    seed({ sentAt: new Date(Date.now() - DAY + 60_000) });
    expect(await (await call()).json()).toEqual({ ok: true, status: "sent" });
    expect(status()).toBe("sent");
  });

  it("a missing shop is a 200 no-op", async () => {
    expect(await (await call(body("gone"))).json()).toEqual({ ok: true, status: null });
  });
});

describe("an email shop and the mailbox sync", () => {
  const synced = (inboxCaughtUpAt: string, lastError: string | null = null) =>
    mem.seed("subAccounts/sa1", { mailboxConfig: { enabled: true, verifiedAt: "x", inboxCaughtUpAt, lastSyncAt: new Date().toISOString(), lastError } });

  it("is not called missed until the mailbox has synced past the window: re-queued in an hour, counted", async () => {
    seed({ channel: "email" });
    synced(new Date(Date.now() - 2 * DAY).toISOString());
    expect(await (await call()).json()).toEqual({ ok: true, status: "awaiting_sync", requeue: 1 });
    expect(mem.read("mysteryShops/s1")).toMatchObject({ status: "sent", awaitingSync: true, timerRequeues: 1 });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      pathname: "/api/automations/prospecting/mystery-shop", body: { shopId: "s1" }, delaySeconds: 3600,
      deduplicationId: expect.stringMatching(/^mystery_shop_s1_requeue_1_/),
    }));
  });

  it("a failing mailbox also waits; a synced, healthy one settles missed", async () => {
    seed({ channel: "email" });
    synced(new Date().toISOString(), "Mailbox login failed.");
    expect((await (await call()).json()).status).toBe("awaiting_sync");
    synced(new Date().toISOString());
    expect(await (await call()).json()).toEqual({ ok: true, status: "missed" });
  });

  it("a shop that only had a failed-sender reply settles missed but disputed", async () => {
    seed({ channel: "email", authFailedReplyAt: new Date(Date.now() - DAY) });
    synced(new Date().toISOString());
    expect(await (await call()).json()).toEqual({ ok: true, status: "missed" });
    expect(mem.read("mysteryShops/s1")).toMatchObject({ status: "missed", disputed: true });
    seed({ channel: "email" });
    await call();
    expect(mem.read("mysteryShops/s1")?.disputed).not.toBe(true);
  });

  it("stops re-queuing after 48 hours of waiting", async () => {
    seed({ channel: "email", timerRequeues: 48 });
    expect(await (await call()).json()).toEqual({ ok: true, status: "awaiting_sync", requeue: null });
    expect(publish).not.toHaveBeenCalled();
  });

  it("a re-queue that cannot be published asks QStash to retry", async () => {
    seed({ channel: "email" });
    publish.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(503);
  });
});

