import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  folderGet: vi.fn(),
  fieldsGet: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  commit: vi.fn(),
  docUpdate: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: m.access,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({ path, get: m.folderGet, update: m.docUpdate }),
    collection: (path: string) => ({
      path,
      where: (field: string, _op: string, value: string) => ({
        get: () => m.fieldsGet(path, field, value),
      }),
    }),
    batch: () => ({ update: m.update, delete: m.del, commit: m.commit }),
  }),
}));
import { DELETE, PATCH } from "./route";

const ctx = { params: Promise.resolve({ id: "tenant", folderId: "fold1" }) };
const req = (method: string, body?: unknown) =>
  new Request("https://example.com", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "admin" });
  m.folderGet.mockResolvedValue({
    exists: true,
    data: () => ({ name: "Billing", entity: "contact", order: 0 }),
  });
  m.fieldsGet.mockResolvedValue({
    size: 2,
    docs: [
      { ref: { path: "subAccounts/tenant/customFields/a" } },
      { ref: { path: "subAccounts/tenant/customFields/b" } },
    ],
  });
});

it("admin guard blocks both endpoints before touching Firestore", async () => {
  m.access.mockResolvedValue(
    NextResponse.json({ error: "Forbidden" }, { status: 403 })
  );
  expect((await DELETE(req("DELETE"), ctx)).status).toBe(403);
  expect((await PATCH(req("PATCH", { name: "x" }), ctx)).status).toBe(403);
  expect(m.folderGet).not.toHaveBeenCalled();
});

it("DELETE moves the folder's fields to General and removes the folder in one batch", async () => {
  const res = await DELETE(req("DELETE"), ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, id: "fold1", movedFields: 2 });

  expect(m.fieldsGet).toHaveBeenCalledWith(
    "subAccounts/tenant/customFields",
    "folderId",
    "fold1"
  );
  expect(m.update).toHaveBeenCalledTimes(2);
  for (const id of ["a", "b"]) {
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `subAccounts/tenant/customFields/${id}`,
      }),
      expect.objectContaining({ folderId: null })
    );
  }
  expect(m.del).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "subAccounts/tenant/customFieldFolders/fold1",
    })
  );
  expect(m.commit).toHaveBeenCalledTimes(1);
});

it("DELETE 404s on a missing folder and writes nothing", async () => {
  m.folderGet.mockResolvedValue({ exists: false, data: () => undefined });
  expect((await DELETE(req("DELETE"), ctx)).status).toBe(404);
  expect(m.commit).not.toHaveBeenCalled();
});

it("PATCH renames and reorders; rejects an empty name", async () => {
  expect((await PATCH(req("PATCH", { name: "  " }), ctx)).status).toBe(400);
  expect(m.docUpdate).not.toHaveBeenCalled();

  const res = await PATCH(
    req("PATCH", { name: " Invoicing ", order: 3.7 }),
    ctx
  );
  expect(res.status).toBe(200);
  expect(m.docUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Invoicing", order: 3 })
  );
});
