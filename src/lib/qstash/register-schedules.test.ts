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
      cron: "*/5 * * * *",
      destination: "https://app.example.com/api/cron/email-sync",
    })
  );
  expect(mock.set).toHaveBeenCalledWith(
    expect.objectContaining({ scheduleVersion: "2026-09-08-email-sync" }),
    { merge: true }
  );
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
  freshMarker({ scheduleVersion: "2026-09-08-email-sync" });
  await ensureSchedulesRegistered();
  expect(mock.create).toHaveBeenCalledWith(
    expect.objectContaining({
      scheduleId: "leadstack-gbp-sync",
      cron: "0 */6 * * *",
      destination: "https://app.example.com/api/cron/gbp-sync",
    })
  );
  expect(mock.set).toHaveBeenCalledWith(
    expect.objectContaining({ scheduleVersion: "2026-09-08-email-sync+gbp-sync" }),
    { merge: true }
  );
});
