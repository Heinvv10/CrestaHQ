import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: m.access,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({ path, get: () => m.get(path), update: m.update }),
  }),
}));
import { PATCH } from "./route";

const ctx = { params: Promise.resolve({ id: "tenant", fieldId: "fld1" }) };
const patch = (body: unknown) =>
  PATCH(
    new Request("https://example.com", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    ctx
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "admin" });
  m.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/customFields/fld1")) {
      return {
        exists: true,
        data: () => ({ entity: "contact", type: "text" }),
      };
    }
    if (path.endsWith("/customFieldFolders/contactFolder")) {
      return { exists: true, data: () => ({ entity: "contact" }) };
    }
    if (path.endsWith("/customFieldFolders/dealFolder")) {
      return { exists: true, data: () => ({ entity: "deal" }) };
    }
    return { exists: false, data: () => undefined };
  });
});

it("moves a field into a folder of the same entity", async () => {
  expect((await patch({ folderId: "contactFolder" })).status).toBe(200);
  expect(m.update).toHaveBeenCalledWith(
    expect.objectContaining({ folderId: "contactFolder" })
  );
});

it("moves a field back to General with null", async () => {
  expect((await patch({ folderId: null })).status).toBe(200);
  expect(m.update).toHaveBeenCalledWith(
    expect.objectContaining({ folderId: null })
  );
});

it("refuses a missing folder or one for the other entity", async () => {
  expect((await patch({ folderId: "nope" })).status).toBe(404);
  expect((await patch({ folderId: "dealFolder" })).status).toBe(404);
  expect((await patch({ folderId: 7 })).status).toBe(400);
  expect(m.update).not.toHaveBeenCalled();
});
