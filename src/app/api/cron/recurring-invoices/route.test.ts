import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: vi.fn(), publishCallback: vi.fn() }));
vi.mock("@/lib/server/recurring-invoice-service", () => ({ runRecurringInvoiceSweep: vi.fn() }));
vi.mock("@/lib/server/auto-charge-stale-sweep", () => ({ recheckStaleAutoCharges: vi.fn() }));

import { publishCallback, verifyQStashSignature } from "@/lib/automations/qstash";
import { recheckStaleAutoCharges } from "@/lib/server/auto-charge-stale-sweep";
import { runRecurringInvoiceSweep } from "@/lib/server/recurring-invoice-service";
import { POST } from "./route";

const call = () =>
  POST(new Request("https://app.test", { method: "POST", headers: { "upstash-signature": "sig" }, body: "{}" }));
const SWEPT = { processed: 2, hasMore: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyQStashSignature).mockResolvedValue(true);
  vi.mocked(runRecurringInvoiceSweep).mockResolvedValue(SWEPT as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("re-checks stale card charges after the sweep and reports them", async () => {
  const summary = { checked: 1, paid: 0, declined: 1, alerted: 0, overBudget: 0 };
  vi.mocked(recheckStaleAutoCharges).mockResolvedValue(summary);
  const res = await call();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, processed: 2, staleCharges: summary });
  expect(vi.mocked(runRecurringInvoiceSweep).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(recheckStaleAutoCharges).mock.invocationCallOrder[0]!,
  );
});

it("a throw inside the re-check leaves the sweep's response as it was", async () => {
  vi.mocked(recheckStaleAutoCharges).mockRejectedValue(new Error("index missing"));
  const res = await call();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, processed: 2, staleCharges: null });
  expect(console.error).toHaveBeenCalledWith(
    "[cron/recurring-invoices] stale card-charge re-check failed",
    expect.any(Error),
  );
});

it("a failed sweep still answers 500 so QStash retries", async () => {
  vi.mocked(runRecurringInvoiceSweep).mockRejectedValue(new Error("down"));
  expect((await call()).status).toBe(500);
});

it("firestore.indexes.json has the composite the stale re-check queries (state, paymentLinkId, createdAt)", () => {
  type Index = { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string }[] };
  const { indexes } = JSON.parse(readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8")) as { indexes: Index[] };
  expect(indexes).toContainEqual({
    collectionGroup: "paymentAttempts",
    queryScope: "COLLECTION",
    fields: ["state", "paymentLinkId", "createdAt"].map((fieldPath) => ({ fieldPath, order: "ASCENDING" })),
  });
});

it("a slow re-check never holds the continuation back: it runs only on the final page", async () => {
  vi.mocked(runRecurringInvoiceSweep).mockResolvedValue({ processed: 50, hasMore: true } as never);
  vi.mocked(publishCallback).mockResolvedValue(undefined as never);
  vi.mocked(recheckStaleAutoCharges).mockImplementation(() => new Promise(() => {})); // e.g. 25 Paystack timeouts
  const res = await call();
  expect(publishCallback).toHaveBeenCalledTimes(1);
  expect(await res.json()).toMatchObject({ continuationScheduled: true, staleCharges: null });
  expect(recheckStaleAutoCharges).not.toHaveBeenCalled();
});

it("a sweep of three pages re-checks once, on the last", async () => {
  vi.mocked(runRecurringInvoiceSweep)
    .mockResolvedValueOnce({ processed: 50, hasMore: true } as never)
    .mockResolvedValueOnce({ processed: 50, hasMore: true } as never)
    .mockResolvedValueOnce({ processed: 3, hasMore: false } as never);
  vi.mocked(publishCallback).mockResolvedValue(undefined as never);
  vi.mocked(recheckStaleAutoCharges).mockResolvedValue({ checked: 25, paid: 0, declined: 0, alerted: 0, overBudget: 0 });
  await call();
  await call();
  await call();
  expect(recheckStaleAutoCharges).toHaveBeenCalledTimes(1);
});

it("breaker R4 rerun: the continuation is queued once and the chain re-checks once", async () => {
  vi.mocked(runRecurringInvoiceSweep)
    .mockResolvedValueOnce({ processed: 50, hasMore: true } as never)
    .mockResolvedValueOnce({ processed: 3, hasMore: false } as never);
  vi.mocked(publishCallback).mockResolvedValue(undefined as never);
  vi.mocked(recheckStaleAutoCharges).mockResolvedValue({ checked: 0, paid: 0, declined: 0, alerted: 0, overBudget: 0 });
  await call();
  await call();
  expect(publishCallback).toHaveBeenCalledTimes(1);
  expect(recheckStaleAutoCharges).toHaveBeenCalledTimes(1);
});

it("R9: a continuation that could not be queued (e.g. the QStash cap) re-checks on this page", async () => {
  vi.mocked(runRecurringInvoiceSweep).mockResolvedValue({ processed: 50, hasMore: true } as never);
  vi.mocked(publishCallback).mockRejectedValue(new Error("QstashDailyRatelimitError"));
  vi.mocked(recheckStaleAutoCharges).mockResolvedValue({ checked: 0, paid: 0, declined: 0, alerted: 0, overBudget: 0 });
  expect((await call()).status).toBe(200);
  expect(recheckStaleAutoCharges).toHaveBeenCalledTimes(1);
});
