import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  get: vi.fn(),
  txGet: vi.fn(),
  txUpdate: vi.fn(),
  getDomain: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-tenancy", () => ({ requireSubAccountAdmin: m.access }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({ get: m.get }),
    runTransaction: (fn: (tx: unknown) => Promise<void>) =>
      fn({ get: m.txGet, update: m.txUpdate }),
  }),
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
const cfg = (status: string, domainId = "d1") => ({
  domainId,
  domainName: "mail.x.com",
  status,
});
const doc = (resendConfig: unknown) => ({ data: () => ({ resendConfig }) });
const fresh = (status: string) =>
  m.getDomain.mockResolvedValue({ ok: true, status, records: [] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  m.access.mockResolvedValue({ email: "admin@example.com" });
});
afterEach(() => vi.unstubAllEnvs());

it("pending -> verified writes once, inside the transaction", async () => {
  m.get.mockResolvedValue(doc(cfg("pending")));
  m.txGet.mockResolvedValue(doc(cfg("pending")));
  fresh("verified");
  const body = await (await call()).json();
  expect(m.txUpdate).toHaveBeenCalledTimes(1);
  expect(m.txUpdate.mock.calls[0][1]).toMatchObject({ "resendConfig.status": "verified" });
  expect(body.status).toBe("verified");
});

it("never downgrades: verified -> pending or failed writes nothing", async () => {
  for (const s of ["pending", "failed"]) {
    m.get.mockResolvedValue(doc(cfg("verified")));
    m.txGet.mockResolvedValue(doc(cfg("verified")));
    fresh(s);
    await call();
  }
  expect(m.txUpdate).not.toHaveBeenCalled();
});

it("does not write when already verified", async () => {
  m.get.mockResolvedValue(doc(cfg("verified")));
  fresh("verified");
  await call();
  expect(m.txUpdate).not.toHaveBeenCalled();
});

it("does not write a non-verified fresh status (pending -> failed)", async () => {
  m.get.mockResolvedValue(doc(cfg("pending")));
  m.txGet.mockResolvedValue(doc(cfg("pending")));
  fresh("failed");
  await call();
  expect(m.txUpdate).not.toHaveBeenCalled();
});

it("domain replaced mid-call -> no write", async () => {
  m.get.mockResolvedValue(doc(cfg("pending", "d1")));
  m.txGet.mockResolvedValue(doc(cfg("pending", "d2")));
  fresh("verified");
  await call();
  expect(m.txUpdate).not.toHaveBeenCalled();
});

it("config deleted mid-call -> no write, never recreated", async () => {
  m.get.mockResolvedValue(doc(cfg("pending")));
  m.txGet.mockResolvedValue(doc(null));
  fresh("verified");
  await call();
  expect(m.txUpdate).not.toHaveBeenCalled();
});

it("status changed mid-call -> no write", async () => {
  m.get.mockResolvedValue(doc(cfg("pending")));
  m.txGet.mockResolvedValue(doc(cfg("failed")));
  fresh("verified");
  await call();
  expect(m.txUpdate).not.toHaveBeenCalled();
});

it("does not write when the Resend lookup failed", async () => {
  m.get.mockResolvedValue(doc(cfg("pending")));
  m.getDomain.mockResolvedValue({ ok: false, status: "failed", records: [], error: "boom" });
  const body = await (await call()).json();
  expect(m.txUpdate).not.toHaveBeenCalled();
  expect(body.status).toBe("pending");
});

it("is a no-op when Resend is not configured or no domain is stored", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  m.get.mockResolvedValue(doc(cfg("pending")));
  await call();
  expect(m.getDomain).not.toHaveBeenCalled();
  m.get.mockResolvedValue({ data: () => ({}) });
  vi.stubEnv("RESEND_API_KEY", "re_test");
  expect((await (await call()).json()).config).toBeNull();
  expect(m.txUpdate).not.toHaveBeenCalled();
});

it("passes an auth refusal through untouched", async () => {
  m.access.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
  const res = await call();
  expect(res.status).toBe(403);
  expect(m.get).not.toHaveBeenCalled();
  expect(m.getDomain).not.toHaveBeenCalled();
});

it("still answers the read when the transaction fails", async () => {
  m.get.mockResolvedValue(doc(cfg("pending")));
  m.txGet.mockRejectedValue(new Error("firestore down"));
  fresh("verified");
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect((await call()).status).toBe(200);
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});
