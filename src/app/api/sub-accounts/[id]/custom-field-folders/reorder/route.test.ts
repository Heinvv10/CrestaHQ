import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  existing: vi.fn(),
  update: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: m.access,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({ path }),
    collection: () => ({
      where: () => ({ get: m.existing }),
    }),
    batch: () => ({ update: m.update, commit: m.commit }),
  }),
}));
import { PUT } from "./route";

const ctx = { params: Promise.resolve({ id: "tenant" }) };
const put = (body: unknown) =>
  PUT(
    new Request("https://example.com", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    ctx,
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "admin" });
  // Sparse orders — what a delete leaves behind (C=2, D=3, E=4).
  m.existing.mockResolvedValue({
    docs: [{ id: "C" }, { id: "D" }, { id: "E" }],
  });
});

it("admin guard blocks before touching Firestore", async () => {
  m.access.mockResolvedValue(
    NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  );
  expect((await put({ entity: "contact", ids: ["C"] })).status).toBe(403);
  expect(m.existing).not.toHaveBeenCalled();
});

it("renumbers every folder densely from the given order in one batch", async () => {
  // Moving D below E on sparse orders must yield C, E, D — not E, C, D.
  const res = await put({ entity: "contact", ids: ["C", "E", "D"] });
  expect(res.status).toBe(200);
  const written = m.update.mock.calls.map(([ref, data]) => [ref.path.split("/").pop(), data.order]);
  expect(written).toEqual([
    ["C", 0],
    ["E", 1],
    ["D", 2],
  ]);
  expect(m.commit).toHaveBeenCalledTimes(1);
});

it("refuses a list that does not cover the entity's folders exactly once", async () => {
  expect((await put({ entity: "contact", ids: ["C", "D"] })).status).toBe(409);
  expect((await put({ entity: "contact", ids: ["C", "D", "E", "X"] })).status).toBe(409);
  expect((await put({ entity: "contact", ids: ["C", "C", "D"] })).status).toBe(400);
  expect((await put({ entity: "nope", ids: ["C"] })).status).toBe(400);
  expect(m.commit).not.toHaveBeenCalled();
});
