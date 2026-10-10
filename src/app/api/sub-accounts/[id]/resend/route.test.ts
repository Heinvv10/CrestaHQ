import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  getDomain: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: m.access }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => ({ get: m.get, update: m.update }) }),
}));
vi.mock("@/lib/comms/resend-domains", () => ({
  createSendingDomain: vi.fn(),
  removeSendingDomain: vi.fn(),
  validateSendingSubdomain: vi.fn(),
  getSendingDomain: m.getDomain,
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({ id: "tenant" }) };
const call = () => GET(new Request("https://example.com"), ctx);
const cfg = (status: string) => ({ domainId: "d1", domainName: "mail.x.com", status });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  m.access.mockResolvedValue({ email: "admin@example.com" });
  m.update.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

const stored = (status: string) =>
  m.get.mockResolvedValue({ data: () => ({ resendConfig: cfg(status) }) });

it("writes the new status when Resend reports a change", async () => {
  stored("pending");
  m.getDomain.mockResolvedValue({ ok: true, status: "verified", records: [] });
  const body = await (await call()).json();
  expect(m.update).toHaveBeenCalledTimes(1);
  expect(m.update.mock.calls[0][0]).toMatchObject({ "resendConfig.status": "verified" });
  expect(body.status).toBe("verified");
});

it("does not write when the status is unchanged", async () => {
  stored("verified");
  m.getDomain.mockResolvedValue({ ok: true, status: "verified", records: [] });
  await call();
  expect(m.update).not.toHaveBeenCalled();
});

it("does not write when the Resend lookup failed", async () => {
  stored("pending");
  m.getDomain.mockResolvedValue({ ok: false, status: "failed", records: [], error: "boom" });
  const body = await (await call()).json();
  expect(m.update).not.toHaveBeenCalled();
  expect(body.status).toBe("pending");
});

it("is a no-op when Resend is not configured or no domain is stored", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  stored("pending");
  await call();
  expect(m.getDomain).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
  m.get.mockResolvedValue({ data: () => ({}) });
  vi.stubEnv("RESEND_API_KEY", "re_test");
  expect((await (await call()).json()).config).toBeNull();
  expect(m.update).not.toHaveBeenCalled();
});

it("still answers the read when the status write fails", async () => {
  stored("pending");
  m.getDomain.mockResolvedValue({ ok: true, status: "verified", records: [] });
  m.update.mockRejectedValue(new Error("firestore down"));
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const res = await call();
  expect(res.status).toBe(200);
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});
