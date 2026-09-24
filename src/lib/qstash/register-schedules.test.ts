import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@upstash/qstash", () => ({
  Client: class {
    schedules = { create: mock.create };
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
    expect.objectContaining({ scheduleVersion: "2026-09-24-ai-models" }),
    { merge: true }
  );
});

it("always registers the daily GBP retention housekeeping — flag or no flag", async () => {
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
        scheduleId: "leadstack-gbp-retention",
        cron: "30 4 * * *",
        destination: "https://app.example.com/api/cron/gbp-retention",
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
    expect.objectContaining({ scheduleVersion: "2026-09-24-ai-models+gbp-sync" }),
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

it("registers the daily WhatsApp staging cleanup — over a marker fresh from the previous version", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "");
  // The marker production holds today. Without a version bump it would skip
  // registration for 24h at a time, and the schedule would never exist.
  freshMarker({ scheduleVersion: "2026-09-17-email-sync-15m" });
  await ensureSchedulesRegistered();
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scheduleId: "leadstack-whatsapp-staging-cleanup",
      cron: "45 4 * * *",
      destination: "https://app.example.com/api/cron/whatsapp-staging-cleanup",
    })
  );
});

it("registers the daily OpenRouter model-list refresh — over a marker fresh from the previous version", async () => {
  productionEnv();
  vi.stubEnv("GBP_SYNC_SCHEDULE_ENABLED", "");
  freshMarker({ scheduleVersion: "2026-09-19-whatsapp-staging-cleanup" });
  await ensureSchedulesRegistered();
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scheduleId: "leadstack-ai-models",
      cron: "20 3 * * *",
      destination: "https://app.example.com/api/cron/ai-models",
    })
  );
});
