import { beforeEach, describe, expect, it, vi } from "vitest";
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
 * Bulk email end to end: send → (fanout) → step, over the in-memory
 * Firestore with QStash drained by hand. These pin the delivery guarantees a
 * customer-facing blast needs: the request returns before the audience is
 * fanned out, a retry never emails anyone twice, every recipient settles so
 * the broadcast completes, and a stop (cancel / pause / agency gate / lost
 * SMTP) is honoured by the rows still waiting.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const { h } = await import("@/test/broadcast-harness");
  return {
    getAdminDb: () => h.mem.db,
    getAdminAuth: () => ({ getUser: async () => ({ displayName: "Operator" }) }),
  };
});
vi.mock("@/lib/automations/qstash", async () =>
  (await import("@/test/broadcast-harness")).qstashMock(),
);
vi.mock("@/lib/comms/resend", async () =>
  (await import("@/test/broadcast-harness")).resendMock(),
);
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", email: "op@tenant.test" }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({
  loadEffectiveTerritoryScope: async () => ({ enforce: false, ids: null }),
}));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
}));
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}`,
}));
vi.mock("@/lib/reviews/review-ask", () => ({ logIfReviewAsk: async () => undefined }));

addRoute("/api/broadcasts/email/fanout", () => import("./fanout/route"));
addRoute("/api/broadcasts/email/cancel", () => import("./cancel/route"));

const isFanout = (m: { pathname: string }) => !isStep(m);

beforeEach(() => resetHarness());

describe("send request", () => {
  it("returns without publishing one message per recipient", async () => {
    seedTenant(30);
    const res = await sendBroadcast();
    expect(res.status).toBe(200);
    // The per-recipient fan-out ran inside the browser request: 25k serial
    // publishes outlive Cloudflare's ~100s and the user retries.
    expect(h.publishLog.filter(isStep)).toHaveLength(0);
    expect(h.publishLog.length).toBeLessThanOrEqual(1);
  });

  it("a retried submit with the same idempotency key emails nobody twice", async () => {
    seedTenant(12);
    const first = (await (await sendBroadcast("retry-key-1")).json()) as { broadcastId: string };
    const second = (await (await sendBroadcast("retry-key-1")).json()) as { broadcastId: string };
    await drain();

    expect(second.broadcastId).toBe(first.broadcastId);
    expect(broadcasts()).toHaveLength(1);
    expect(h.sent).toHaveLength(12);
    expect(new Set(h.sent.map((s) => s.contactId)).size).toBe(12);
  });

  it("refuses a request without an idempotency key", async () => {
    seedTenant(3);
    const res = await call("/api/broadcasts/email/send", {
      subAccountId: "sa1",
      templateId: "t1",
      audienceFilter: { kind: "all" },
    });
    expect(res.status).toBe(400);
    expect(broadcasts()).toHaveLength(0);
  });
});

describe("fan-out", () => {
  it("pages through a large audience and queues everyone exactly once", async () => {
    seedTenant(450);
    await sendBroadcast();
    await drain(isFanout);

    // More than one fan-out page ran: the audience was never loaded whole.
    expect(h.publishLog.filter(isFanout).length).toBeGreaterThanOrEqual(3);
    const steps = h.publishLog.filter(isStep);
    expect(new Set(steps.map((m) => m.body.contactId)).size).toBe(450);
    expect(steps).toHaveLength(450);

    await drain();
    const [b] = broadcasts();
    expect(b!.status).toBe("completed");
    expect(b!.totals).toMatchObject({ audienceSize: 450, queued: 0, sent: 450 });
  });

  it("does not complete between pages when the first page has drained", async () => {
    seedTenant(450);
    await sendBroadcast();
    const [firstPage] = h.queue.splice(0, 1);
    await call(firstPage!.pathname, firstPage!.body);
    await drain(isStep);

    expect(h.sent).toHaveLength(200);
    expect(broadcasts()[0]!.status).not.toBe("completed");
    await drain();
    expect(broadcasts()[0]!.status).toBe("completed");
    expect(h.sent).toHaveLength(450);
  });

  it("completes the broadcast when some publishes fail", async () => {
    seedTenant(5);
    h.failPublish = (m) => isStep(m) && m.body.contactId === "c0002";
    await sendBroadcast();
    await drain();

    const [b] = broadcasts();
    expect(b!.status).toBe("completed");
    expect(b!.totals).toMatchObject({ queued: 0, sent: 4, failed: 1 });
    const row = h.mem.read(`broadcasts/${b!.id}/sends/c0002`);
    expect(row).toMatchObject({ status: "failed" });
    expect(String(row!.error)).toMatch(/schedul/i);
  });
});

describe("step", () => {
  it("a redelivered step running concurrently sends once", async () => {
    seedTenant(1);
    await sendBroadcast();
    await drain(isFanout);
    const [msg] = h.queue.filter(isStep);
    h.queue.length = 0;

    await Promise.all([
      call(msg!.pathname, msg!.body),
      call(msg!.pathname, msg!.body),
    ]);
    expect(h.sent).toHaveLength(1);
    expect(broadcasts()[0]!.totals).toMatchObject({ sent: 1, queued: 0 });
  });

  it("fails rows terminally, with a reason, when SMTP disconnects mid-broadcast", async () => {
    seedTenant(3);
    await sendBroadcast();
    await drain(isFanout);
    h.smtpConnected = false;
    const responses = await drain();

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(h.sent).toHaveLength(0);
    const [b] = broadcasts();
    expect(b!.status).toBe("completed");
    expect(b!.totals).toMatchObject({ queued: 0, failed: 3 });
    const rows = h.mem.list(`broadcasts/${b!.id}/sends`);
    expect(rows.every((r) => r.status === "failed" && /not configured/i.test(String(r.error)))).toBe(true);
  });

  it("stops pending sends when the operator cancels", async () => {
    seedTenant(4);
    const { broadcastId } = (await (await sendBroadcast()).json()) as { broadcastId: string };
    await drain(isFanout);
    const res = await call("/api/broadcasts/email/cancel", { broadcastId });
    expect(res.status).toBe(200);
    await drain();

    expect(h.sent).toHaveLength(0);
    const [b] = broadcasts();
    expect(b!.status).toBe("cancelled");
    expect(b!.totals).toMatchObject({ queued: 0, skipped: 4 });
    const rows = h.mem.list(`broadcasts/${broadcastId}/sends`);
    expect(rows.every((r) => r.skippedReason === "cancelled")).toBe(true);
  });

  it("stops fanning out once cancelled", async () => {
    seedTenant(450);
    const { broadcastId } = (await (await sendBroadcast()).json()) as { broadcastId: string };
    await call("/api/broadcasts/email/cancel", { broadcastId });
    await drain();
    expect(h.publishLog.filter(isStep)).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it.each([
    ["automationsPaused", { automationsPaused: true }, "automations_paused"],
    ["the agency gate", { broadcastsEnabledByAgency: false }, "agency_disabled"],
  ])("honours %s flipped after the send started", async (_label, patch, reason) => {
    seedTenant(2);
    await sendBroadcast();
    await drain(isFanout);
    const sub = h.mem.read("subAccounts/sa1")!;
    h.mem.seed("subAccounts/sa1", { ...sub, ...patch });
    await drain();

    expect(h.sent).toHaveLength(0);
    const [b] = broadcasts();
    expect(b!.status).toBe("completed");
    const rows = h.mem.list(`broadcasts/${b!.id}/sends`);
    expect(rows.every((r) => r.status === "skipped" && r.skippedReason === reason)).toBe(true);
  });
});
