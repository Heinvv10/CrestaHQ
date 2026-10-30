import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * PATCH /recurring-invoices/[recurringId] — the wiring between the stored
 * schedule and `parseScheduleUpdate`. The arithmetic is pinned in
 * `schedule-input.test.ts`; this pins that the route feeds it the run state
 * it needs and writes back what it returns.
 */

const m = vi.hoisted(() => ({
  access: vi.fn(),
  stored: null as Record<string, unknown> | null,
  written: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: m.access }));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: vi.fn() }));
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: vi.fn() }));
vi.mock("@/lib/server/quote-send-service", () => ({ sendQuoteServerSide: vi.fn() }));
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: vi.fn(),
  territoryForContact: vi.fn(),
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({ exists: !!m.stored, id: "sch_1", data: () => m.stored }),
      update: async (patch: Record<string, unknown>) => {
        m.written.push(patch);
      },
    }),
  }),
}));

import { PATCH } from "./route";

const ts = (iso: string) => ({ toDate: () => new Date(iso) });
const ctx = { params: Promise.resolve({ id: "sa_1", recurringId: "sch_1" }) };
const patch = (body: unknown) =>
  PATCH(
    new Request("https://example.com", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
const localDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d);

beforeEach(() => {
  m.written.length = 0;
  m.access.mockResolvedValue({ uid: "u_1", subAccountId: "sa_1" });
  m.stored = {
    subAccountId: "sa_1",
    status: "active",
    cadence: { unit: "month", interval: 1 },
    anchorDay: 15,
    timezone: "UTC",
    nextRunAt: ts("2026-07-15T00:00:00Z"),
    lastRunAt: null,
  };
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("never points an edit at a cycle the schedule already billed today", async () => {
  vi.setSystemTime(new Date("2026-06-15T08:00:00Z"));
  m.stored!.lastRunAt = ts("2026-06-15T05:00:00Z");

  expect((await patch({ cadence: { unit: "quarter", interval: 1 } })).status).toBe(200);

  const next = (m.written[0].nextRunAt as { toDate: () => Date }).toDate();
  expect(localDay(next)).toBe("2026-09-15");
});

it("moves a resumed schedule past the cycles it missed while paused", async () => {
  vi.setSystemTime(new Date("2026-06-20T12:00:00Z"));
  m.stored!.status = "paused";
  m.stored!.nextRunAt = ts("2026-03-15T00:00:00Z");

  expect((await patch({ status: "active" })).status).toBe(200);

  expect(m.written[0].status).toBe("active");
  const next = (m.written[0].nextRunAt as { toDate: () => Date }).toDate();
  expect(localDay(next)).toBe("2026-07-15");
  // The skipped cycles land on the operator's list rather than vanishing.
  expect(String(m.written[0].lastError)).toContain("2026-03-15");
});

it("clears lastError on an ordinary edit", async () => {
  vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
  expect((await patch({ name: "Renamed" })).status).toBe(200);
  expect(m.written[0].lastError).toBeNull();
});
