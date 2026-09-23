import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The delivery worker is where a stored subscription URL is actually
 * fetched, and it writes the response body + headers into a delivery row the
 * tenant can read. Whatever got the URL into Firestore (an older row, a
 * PATCH, DNS that changed since), the worker itself must refuse to connect
 * to an internal address. A loopback server stands in for an internal
 * service on this box.
 */

let subscriptionUrl = "";
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: async () => true,
}));
vi.mock("@/lib/firestore/webhook-events", () => ({
  getDelivery: async () => ({
    id: "d1",
    status: "pending",
    attempt: 4, // last attempt → no retry scheduling
    subscriptionId: "s1",
    agencyId: "ag1",
  }),
  getEvent: async () => ({
    id: "e1",
    type: "contact.created",
    createdAt: new Date(),
    mode: "live",
    payload: {},
  }),
  updateDelivery: async (_s: string, _e: string, _d: string, patch: Record<string, unknown>) => {
    updates.push(patch);
  },
  createDelivery: async () => ({ id: "d2" }),
}));
vi.mock("@/lib/firestore/webhook-subscriptions", () => ({
  getSubscription: async () => ({
    id: "s1",
    status: "active",
    url: subscriptionUrl,
    signingSecret: "whsec_test",
  }),
  recordSubscriptionFailure: async () => ({ tripped: false }),
  recordSubscriptionSuccess: async () => undefined,
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  scheduleDeliveryRetry: async () => undefined,
}));

import { POST } from "@/app/api/webhooks-out/step/route";

let hits = 0;
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "X-Internal": "secret" });
    res.end("internal-body");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits = 0;
  updates.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

function step() {
  return POST(
    new Request("https://app.test/api/webhooks-out/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ subAccountId: "sa1", eventId: "e1", deliveryId: "d1" }),
    }),
  );
}

describe("webhooks-out step — SSRF guard at fetch time", () => {
  it("refuses a loopback subscription URL in production and records no response", async () => {
    vi.stubEnv("NODE_ENV", "production");
    subscriptionUrl = `http://127.0.0.1:${port}/hook`;
    await step();
    expect(hits).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "exhausted", responseBody: null, responseHeaders: null });
    expect(String(updates[0]!.errorMessage)).toMatch(/not a public/);
  });

  it("still delivers outside production (local dev receiver)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    subscriptionUrl = `http://127.0.0.1:${port}/hook`;
    await step();
    expect(hits).toBe(1);
    expect(updates[0]).toMatchObject({ status: "succeeded", responseBody: "internal-body" });
  });
});
