import { beforeEach, expect, it, vi } from "vitest";

/**
 * The daily cron is what guarantees a pro-rated gap invoice: it raises every
 * pending one before the cycles run, and a failure there never stops them.
 */

const m = vi.hoisted(() => ({ sweep: vi.fn(), pending: vi.fn(), order: [] as string[] }));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true, publishCallback: vi.fn() }));
vi.mock("@/lib/server/recurring-invoice-service", () => ({ runRecurringInvoiceSweep: m.sweep }));
vi.mock("@/lib/server/recurring-prorate", () => ({ raisePendingProrations: m.pending }));

import { POST } from "./route";

const call = () => POST(new Request("https://x", { method: "POST", headers: { "upstash-signature": "sig" }, body: "{}" }));

beforeEach(() => {
  vi.clearAllMocks();
  m.order.length = 0;
  m.sweep.mockImplementation(async () => (m.order.push("sweep"), { processed: 0, generated: 0, skipped: 0, failed: 0, hasMore: false }));
  m.pending.mockImplementation(async () => (m.order.push("pending"), 0));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("raises pending pro-rated gaps, then runs the cycles", async () => {
  expect((await call()).status).toBe(200);
  expect(m.order).toEqual(["pending", "sweep"]);
});

it("a failure raising pending gaps does not stop the cycles", async () => {
  m.pending.mockRejectedValueOnce(new Error("firestore down"));
  expect((await call()).status).toBe(200);
  expect(m.sweep).toHaveBeenCalledTimes(1);
});
