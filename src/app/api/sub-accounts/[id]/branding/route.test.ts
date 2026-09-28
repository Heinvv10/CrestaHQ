import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: m.access,
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "ts" },
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({ path, set: (v: unknown, o: unknown) => m.set(path, v, o) }),
  }),
}));
import { PATCH } from "./route";

const ctx = { params: Promise.resolve({ id: "sa1" }) };
const patch = (body: unknown) =>
  PATCH(new Request("https://example.com", { method: "PATCH", body: JSON.stringify(body) }), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "admin", subAccountId: "sa1" });
});

it("accepts a valid E.164 WhatsApp number", async () => {
  const res = await patch({ whatsappNumber: "+27821234567" });
  expect(res.status).toBe(200);
  expect(m.set).toHaveBeenCalledWith(
    "subAccounts/sa1",
    expect.objectContaining({ whatsappNumber: "+27821234567" }),
    { merge: true },
  );
});

it("rejects a WhatsApp number that does not parse as E.164", async () => {
  const res = await patch({ whatsappNumber: "not-a-number" });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/E\.164/);
  expect(m.set).not.toHaveBeenCalled();
});

it("clears the WhatsApp number with null or empty string", async () => {
  await patch({ whatsappNumber: null });
  expect(m.set).toHaveBeenCalledWith("subAccounts/sa1", expect.objectContaining({ whatsappNumber: null }), { merge: true });
  m.set.mockClear();
  await patch({ whatsappNumber: "" });
  expect(m.set).toHaveBeenCalledWith("subAccounts/sa1", expect.objectContaining({ whatsappNumber: null }), { merge: true });
});

it("still validates logoUrl independently of whatsappNumber", async () => {
  const res = await patch({ logoUrl: "not-a-url" });
  expect(res.status).toBe(400);
  expect(m.set).not.toHaveBeenCalled();
});
