import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@upstash/qstash", () => ({
  Client: class {
    schedules = { create: mock.create, delete: mock.delete };
  },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => ({ get: mock.get, set: mock.set }) }),
}));
import { ensureSchedulesRegistered } from "./register-schedules";
afterEach(() => vi.unstubAllEnvs());
it("registers the new mailbox schedule immediately despite a fresh older cache", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("QSTASH_TOKEN", "test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
  // Hermetic: a developer shell that sourced .env.local may enable GBP sync.
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "");
  mock.get.mockResolvedValue({
    exists: true,
    data: () => ({
      baseUrl: "https://app.example.com",
      registeredAt: new Date(),
    }),
  });
  await ensureSchedulesRegistered();
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scheduleId: "leadstack-email-sync",
      cron: "*/15 * * * *",
      destination: "https://app.example.com/api/cron/email-sync",
    })
  );
  expect(mock.set).toHaveBeenCalledWith(
    expect.objectContaining({ scheduleVersion: "2026-09-28-daily-housekeeping" }),
    { merge: true }
  );
});

it("always registers the daily housekeeping (which carries GBP retention) — flag or no flag", async () => {
  for (const flag of ["", "1"]) {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QSTASH_TOKEN", "test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", flag);
    mock.create.mockReset();
    mock.get.mockResolvedValue({ exists: false, data: () => ({}) });
    await ensureSchedulesRegistered();
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "leadstack-daily-housekeeping",
        cron: "0 3 * * *",
        destination: "https://app.example.com/api/cron/daily-housekeeping",
      })
    );
  }
});

function freshMarker(extra: Record<string, unknown> = {}) {
  mock.create.mockReset();
  mock.set.mockReset();
  mock.get.mockResolvedValue({
    exists: true,
    data: () => ({ baseUrl: "https://app.example.com", registeredAt: new Date(), ...extra }),
  });
}

function productionEnv() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("QSTASH_TOKEN", "test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
}

it("does NOT register the GBP sync schedule unless the deployment opts in", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "");
  freshMarker();
  await ensureSchedulesRegistered();
  expect(mock.create).not.toHaveBeenCalledWith(expect.objectContaining({ scheduleId: "leadstack-gbp-sync" }));
});

it("registers the 6-hourly GBP sync when GBP_SYNC_SCHEDULE_ENABLED=1 — even over a fresh marker", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "1");
  // A marker fresh from before the flag was turned on must not suppress it.
  freshMarker({ scheduleVersion: "2026-09-11-gbp-retention" });
  await ensureSchedulesRegistered();
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scheduleId: "leadstack-gbp-sync",
      cron: "0 */6 * * *",
      destination: "https://app.example.com/api/cron/gbp-sync",
    })
  );
  expect(mock.set).toHaveBeenCalledWith(
    expect.objectContaining({ scheduleVersion: "2026-09-28-daily-housekeeping+gbp-sync" }),
    { merge: true }
  );
});

it("registers the hourly WhatsApp quality poll (SP15) with the base schedules", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "");
  freshMarker({ scheduleVersion: "2026-09-11-gbp-retention" }); // pre-SP15 marker must not suppress it
  await ensureSchedulesRegistered();
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scheduleId: "leadstack-whatsapp-quality",
      cron: "15 * * * *",
      destination: "https://app.example.com/api/cron/whatsapp-quality",
    })
  );
});

it("registers the 15-minute prospect report announce sweep — over a marker fresh from the previous version", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "");
  freshMarker({ scheduleVersion: "2026-09-24-ai-models" });
  await ensureSchedulesRegistered();
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scheduleId: "leadstack-prospect-announce",
      cron: "*/15 * * * *",
      destination: "https://app.example.com/api/automations/prospecting/announce-sweep",
    })
  );
});

const RETIRED = [
  "leadstack-gitpage-heartbeat",
  "leadstack-ai-models",
  "leadstack-api-cleanup",
  "leadstack-gbp-retention",
  "leadstack-whatsapp-staging-cleanup",
];

/**
 * A QStash account at its 10-schedule cap, holding exactly what production
 * held on 2026-09-28. `create` of a NEW id fails on quota like the real API;
 * `delete` of an unknown id answers 404.
 */
function fullQStash() {
  const held = new Set([
    "leadstack-agents-watchdog",
    "leadstack-email-sync",
    "leadstack-gbp-sync",
    "leadstack-recurring-invoices",
    "leadstack-whatsapp-quality",
    ...RETIRED,
  ]);
  let peak = held.size;
  mock.create.mockReset();
  mock.delete.mockReset();
  mock.create.mockImplementation(async ({ scheduleId }: { scheduleId: string }) => {
    if (!held.has(scheduleId) && held.size >= 10) {
      throw new Error('{"error":"quota maxSchedules exceeded, current limit: 10"}');
    }
    held.add(scheduleId);
    peak = Math.max(peak, held.size);
  });
  mock.delete.mockImplementation(async (id: string) => {
    if (!held.delete(id)) throw Object.assign(new Error("schedule not found"), { status: 404 });
  });
  return { held, peak: () => peak };
}

it("frees the five retired slots BEFORE creating, so a full plan still gets daily-housekeeping and announce", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "1");
  freshMarker({ scheduleVersion: "2026-09-28-prospect-announce" });
  const qstash = fullQStash();
  await ensureSchedulesRegistered();

  expect(mock.delete.mock.calls.map(([id]) => id)).toEqual(RETIRED);
  const lastDelete = Math.max(...mock.delete.mock.invocationCallOrder);
  expect(Math.min(...mock.create.mock.invocationCallOrder)).toBeGreaterThan(lastDelete);
  expect([...qstash.held].sort()).toEqual([
    "leadstack-agents-watchdog",
    "leadstack-daily-housekeeping",
    "leadstack-email-sync",
    "leadstack-gbp-sync",
    "leadstack-prospect-announce",
    "leadstack-recurring-invoices",
    "leadstack-whatsapp-quality",
  ]);
  expect(qstash.peak()).toBeLessThanOrEqual(10);
  const { lastResults } = mock.set.mock.calls[0][0] as { lastResults: Array<{ ok: boolean }> };
  expect(lastResults.every((r) => r.ok)).toBe(true);
  // None of the retired ids is ever re-created.
  for (const id of RETIRED) {
    expect(mock.create).not.toHaveBeenCalledWith(expect.objectContaining({ scheduleId: id }));
  }
});

it("treats an already-deleted retired schedule as a no-op on the next run", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "1");
  freshMarker({ scheduleVersion: "2026-09-28-prospect-announce" });
  const qstash = fullQStash();
  await ensureSchedulesRegistered();
  mock.set.mockReset();
  mock.get.mockResolvedValue({ exists: false, data: () => ({}) });
  await ensureSchedulesRegistered(); // every delete now answers 404
  expect(qstash.held.size).toBe(7);
  const { lastResults } = mock.set.mock.calls[0][0] as { lastResults: Array<{ ok: boolean }> };
  expect(lastResults.every((r) => r.ok)).toBe(true);
});

it("reports a retired delete that fails for another reason, and still registers the rest", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "");
  freshMarker({ scheduleVersion: "2026-09-28-prospect-announce" });
  mock.delete.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
  await ensureSchedulesRegistered();
  const { lastResults } = mock.set.mock.calls[0][0] as {
    lastResults: Array<{ id: string; ok: boolean; error?: string }>;
  };
  expect(lastResults.filter((r) => !r.ok).map((r) => r.id)).toEqual(RETIRED.map((id) => `${id} (deleted)`));
  expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: "leadstack-daily-housekeeping" }));
});
