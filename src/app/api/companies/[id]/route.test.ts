import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  admin: vi.fn(),
  del: vi.fn(),
  exists: true,
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: m.admin,
}));
const db = { doc: (path: string) => ({ path, get: async () => ({ exists: m.exists, data: () => ({ subAccountId: "sa1" }) }) }) };
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => db }));
vi.mock("@/lib/server/companies-service", () => ({
  deleteCompanyAndUnlinkContacts: m.del,
}));
import { DELETE } from "./route";

const del = () =>
  DELETE(new Request("https://example.com/api/companies/co1", { method: "DELETE" }), {
    params: Promise.resolve({ id: "co1" }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.exists = true;
  m.admin.mockResolvedValue({ uid: "u1" });
  m.del.mockResolvedValue(2);
});

it("deletes through the service with the company's own sub-account", async () => {
  const res = await del();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, unlinked: 2 });
  expect(m.admin).toHaveBeenCalledWith(expect.any(Request), "sa1");
  expect(m.del).toHaveBeenCalledWith(db, "co1", "sa1");
});

it("refuses a non-admin", async () => {
  m.admin.mockResolvedValue(
    NextResponse.json({ error: "Sub-account admin only" }, { status: 403 }),
  );
  const res = await del();
  expect(res.status).toBe(403);
  expect(m.del).not.toHaveBeenCalled();
});

it("404s an unknown company before any tenancy lookup", async () => {
  m.exists = false;
  const res = await del();
  expect(res.status).toBe(404);
  expect(m.admin).not.toHaveBeenCalled();
});
