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
