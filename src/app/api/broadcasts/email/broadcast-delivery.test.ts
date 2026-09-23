import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  addRoute,
  broadcasts,
  call,
  drain,
  h,
  isStep,
  resetHarness,
  seedTenant,
  sendBroadcast,
} from "@/test/broadcast-harness";

/**
 * Bulk email — the review-round guarantees: a step that fails after taking
 * its claim is retried (or, once past the provider, never re-sent), fan-out
 * pages survive redelivery and final failure, and the send is territory-
 * scoped and retry-safe. Same harness as broadcast-flow.test.ts; nothing
 * leaves the process.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const { harnessDb } = await import("@/test/broadcast-harness");
  return {
    getAdminDb: () => harnessDb(),
    getAdminAuth: () => ({ getUser: async () => ({ displayName: "Operator" }) }),
  };
});
vi.mock("@/lib/automations/qstash", async () =>
  (await import("@/test/broadcast-harness")).qstashMock(),
);
vi.mock("@/lib/comms/resend", async () =>
  (await import("@/test/broadcast-harness")).resendMock(),
);
vi.mock("@/lib/auth/require-tenancy", async () =>
  (await import("@/test/broadcast-harness")).tenancyMocks.tenancy(),
);
vi.mock("@/lib/auth/territory-filter", async () =>
  (await import("@/test/broadcast-harness")).tenancyMocks.territory(),
);
vi.mock("@/lib/server/usage-meter", async () =>
  (await import("@/test/broadcast-harness")).usageMock(),
);
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}`,
}));
const after = vi.hoisted(() => ({ throws: 0 }));
vi.mock("@/lib/reviews/review-ask", () => ({
  // Runs after the row is settled — a throw here is a post-settle failure.
  logIfReviewAsk: async () => {
    if (after.throws > 0) {
      after.throws -= 1;
      throw new Error("post-settle blip");
    }
  },
}));

addRoute("/api/broadcasts/email/fanout", () => import("./fanout/route"));
addRoute("/api/broadcasts/email/cancel", () => import("./cancel/route"));

const isFanout = (m: { pathname: string }) => !isStep(m);
const firstFanout = () => h.queue.splice(h.queue.findIndex(isFanout), 1)[0]!;

async function queuedStep(): Promise<{ pathname: string; body: Record<string, unknown> }> {
  seedTenant(1);
  await sendBroadcast();
  await drain(isFanout);
  const [msg] = h.queue.filter(isStep);
  h.queue.length = 0;
  return msg!;
}
const row = () => h.mem.list(`broadcasts/${broadcasts()[0]!.id}/sends`)[0]!;

beforeEach(() => {
  resetHarness();
  after.throws = 0;
});

describe("step failing after its claim", () => {
  it("a read blip before the provider releases the claim, so the retry sends", async () => {
    const msg = await queuedStep();
    h.quotaThrows = 1;
    expect((await call(msg.pathname, msg.body)).status).toBe(500);
    expect(h.sent).toHaveLength(0);
    expect(row().claimedAt).toBeUndefined();

    expect((await call(msg.pathname, msg.body)).status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(broadcasts()[0]).toMatchObject({ status: "completed", totals: { sent: 1, queued: 0 } });
  });

  it("a settle-write blip after a successful send is retried in-process", async () => {
    const msg = await queuedStep();
    h.failCommits = 1;
    expect((await call(msg.pathname, msg.body)).status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(row()).toMatchObject({ status: "sent" });
    expect(broadcasts()[0]).toMatchObject({ status: "completed", totals: { sent: 1, queued: 0 } });
  });

  it("a failure after the email went out keeps the claim, so a retry never re-sends", async () => {
    const msg = await queuedStep();
    h.failCommits = 3; // every in-process settle attempt fails
    expect((await call(msg.pathname, msg.body)).status).toBe(500);
    expect(h.sent).toHaveLength(1);
    expect(row().claimedAt).toBeDefined();

    expect((await call(msg.pathname, msg.body)).status).toBe(503);
    expect(h.sent).toHaveLength(1);
  });

  it("a retry after a post-settle failure still completes the broadcast", async () => {
    const msg = await queuedStep();
    after.throws = 1;
    expect((await call(msg.pathname, msg.body)).status).toBe(500);
    expect(broadcasts()[0]!.status).not.toBe("completed");

    expect((await call(msg.pathname, msg.body)).status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(broadcasts()[0]).toMatchObject({ status: "completed", totals: { sent: 1, queued: 0 } });
  });

  it("a delivery finding a fresh claim answers 503 so QStash keeps retrying", async () => {
    const msg = await queuedStep();
    const path = `broadcasts/${broadcasts()[0]!.id}/sends/c0000`;
    h.mem.seed(path, { ...h.mem.read(path), claimedAt: Timestamp.now() });
    expect((await call(msg.pathname, msg.body)).status).toBe(503);
    expect(h.sent).toHaveLength(0);
  });

  it("a stale claim is settled failed as delivery unknown, never re-sent", async () => {
    const msg = await queuedStep();
    const path = `broadcasts/${broadcasts()[0]!.id}/sends/c0000`;
    h.mem.seed(path, { ...h.mem.read(path), claimedAt: Timestamp.fromMillis(Date.now() - 11 * 60_000) });
    expect((await call(msg.pathname, msg.body)).status).toBe(200);
    expect(h.sent).toHaveLength(0);
    expect(row()).toMatchObject({ status: "failed" });
    expect(String(row().error)).toMatch(/delivery unknown/i);
    expect(broadcasts()[0]).toMatchObject({ status: "completed", totals: { failed: 1, queued: 0 } });
  });
});

describe("fan-out delivery", () => {
  it("a page redelivered after dying mid-publish settles rows whose contact changed", async () => {
    seedTenant(4);
    await sendBroadcast();
    const page = firstFanout();
    h.throwPublish = isStep;
    expect((await call(page.pathname, page.body)).status).toBe(500);
    h.throwPublish = () => false;
    h.queue.length = 0;
    h.mem.seed("contacts/c0001", { ...h.mem.read("contacts/c0001"), emailOptedOut: true });
    await h.mem.db.doc("contacts/c0002").delete();

    await call(page.pathname, page.body);
    await drain();
    expect(h.sent.map((s) => s.contactId).sort()).toEqual(["c0000", "c0003"]);
    expect(broadcasts()[0]).toMatchObject({
      status: "completed",
      totals: { queued: 0, sent: 2, skipped: 2 },
    });
  });

  it("two concurrent deliveries of one page queue everyone once", async () => {
    seedTenant(30);
    await sendBroadcast();
    const page = firstFanout();
    await Promise.all([call(page.pathname, page.body), call(page.pathname, page.body)]);
    await drain();
    expect(h.sent).toHaveLength(30);
    expect(broadcasts()[0]).toMatchObject({
      status: "completed",
      totals: { audienceSize: 30, queued: 0, sent: 30 },
    });
  });

  it("a page failing on its final retry fails the broadcast visibly", async () => {
    seedTenant(450);
    await sendBroadcast();
    const page = firstFanout();
    h.failPublish = isFanout;
    expect((await call(page.pathname, page.body, { "upstash-retried": "1" })).status).toBe(500);
    expect(broadcasts()[0]!.status).not.toBe("failed");
    expect((await call(page.pathname, page.body, { "upstash-retried": "3" })).status).toBe(200);
    expect(broadcasts()[0]).toMatchObject({ status: "failed" });
    expect(String(broadcasts()[0]!.errorMessage)).toMatch(/fan-out/i);
  });
});

describe("send request", () => {
  it("a retry after the first attempt died before its fan-out publish starts the fan-out", async () => {
    seedTenant(3);
    h.throwPublish = isFanout;
    await expect(sendBroadcast("dead-key-1")).rejects.toThrow();
    h.throwPublish = () => false;
    expect((await sendBroadcast("dead-key-1")).status).toBe(200);
    await drain();
    expect(h.sent).toHaveLength(3);
  });

  it("a retry of a broadcast that failed to start is reported as failed", async () => {
    seedTenant(3);
    h.failPublish = isFanout;
    expect((await sendBroadcast("dead-key-2")).status).toBe(502);
    h.failPublish = () => false;
    expect((await sendBroadcast("dead-key-2")).status).toBe(502);
    expect(h.queue).toHaveLength(0);
  });

  it("a territory-scoped send counts only the caller's territories", async () => {
    seedTenant(5);
    for (const id of ["c0001", "c0003"]) {
      h.mem.seed(`contacts/${id}`, { ...h.mem.read(`contacts/${id}`), territoryId: "t1" });
    }
    h.scope = { enforce: true, ids: ["t1"] };
    const res = (await (await sendBroadcast("scoped-key-1")).json()) as { audienceSize: number };
    expect(res.audienceSize).toBe(2);
    await drain();
    expect(h.sent.map((s) => s.contactId).sort()).toEqual(["c0001", "c0003"]);
  });

  it("a territory-scoped send with no contacts in scope is refused", async () => {
    seedTenant(5);
    h.scope = { enforce: true, ids: ["t9"] };
    expect((await sendBroadcast("scoped-key-2")).status).toBe(400);
    expect(broadcasts()).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("checks membership before revealing whether a broadcast exists", async () => {
    h.member = false;
    const res = await call("/api/broadcasts/email/cancel", { broadcastId: "nope", subAccountId: "sa1" });
    expect(res.status).toBe(403);
  });

  it("refuses a broadcast from another sub-account as not found", async () => {
    seedTenant(1);
    const { broadcastId } = (await (await sendBroadcast()).json()) as { broadcastId: string };
    const res = await call("/api/broadcasts/email/cancel", { broadcastId, subAccountId: "sa2" });
    expect(res.status).toBe(404);
    expect(broadcasts()[0]!.status).not.toBe("cancelled");
  });
});
