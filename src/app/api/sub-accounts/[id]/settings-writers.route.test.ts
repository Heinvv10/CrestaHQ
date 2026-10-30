import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The create routes whose writers moved to lib (PR10: custom fields,
 * custom-field folders, products) still answer and write as before, and a
 * person's write carries no agent stamp. (Snippet PATCH: snippets/route.test.ts.)
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1" }),
  requireSubAccountMember: async () => ({ uid: "u1" }),
}));

const { POST: createField } = await import("./custom-fields/route");
const { POST: createFolder } = await import("./custom-field-folders/route");
const { POST: createProduct } = await import("./products/route");

const ctx = { params: Promise.resolve({ id: "sa1" }) };
const post = (body: unknown) => new Request("https://app.test/x", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
});

it("custom-fields POST creates the field with a generated key, unstamped", async () => {
  mem.seed("subAccounts/sa1/customFields/cf1", { entity: "contact", key: "install_date", label: "Install date", order: 0 });
  const res = await createField(post({ entity: "contact", label: "Install date", type: "text" }), ctx);
  expect(res.status).toBe(200);
  const { id, key } = (await res.json()) as { id: string; key: string };
  expect(key).toBe("install_date_2");
  const doc = mem.read(`subAccounts/sa1/customFields/${id}`)!;
  expect(doc).toMatchObject({ key: "install_date_2", order: 1, agencyId: "ag1", createdByUid: "u1" });
  expect(doc.lastAgentEditKey).toBeUndefined();
  expect((await createField(post({ entity: "contact", label: "", type: "text" }), ctx)).status).toBe(400);
});

it("custom-field-folders POST appends the folder, unstamped", async () => {
  const res = await createFolder(post({ name: "Install", entity: "contact" }), ctx);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(mem.read(`subAccounts/sa1/customFieldFolders/${id}`)).toMatchObject({ name: "Install", entity: "contact", order: 0, createdByUid: "u1" });
  expect(mem.read(`subAccounts/sa1/customFieldFolders/${id}`)!.lastAgentEditKey).toBeUndefined();
  expect((await createFolder(post({ name: "X", entity: "company" }), ctx)).status).toBe(400);
});

it("products POST creates the product from the sanitized payload, unstamped", async () => {
  const res = await createProduct(post({ name: " Fibre ", unitPriceCents: 499.4, currency: "zar" }), ctx);
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  expect(mem.read(`products/${id}`)).toMatchObject({ name: "Fibre", unitPriceCents: 499, currency: "ZAR", agencyId: "ag1", createdByUid: "u1" });
  expect(mem.read(`products/${id}`)!.lastAgentEditKey).toBeUndefined();
  expect((await createProduct(post({ unitPriceCents: 1 }), ctx)).status).toBe(400);
});
