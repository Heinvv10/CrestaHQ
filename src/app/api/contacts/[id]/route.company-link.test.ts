import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  update: vi.fn(),
  companies: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({}),
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () =>
        path.startsWith("companies/")
          ? { exists: m.companies.has(path), data: () => m.companies.get(path) }
          : {
              exists: true,
              data: () => ({ subAccountId: "sa1", agencyId: "ag1", mode: "live" }),
            },
    }),
  }),
}));
vi.mock("@/lib/custom-fields/load-defs", () => ({
  loadCustomFieldDefs: async () => [],
}));
vi.mock("@/lib/server/contacts-service", () => ({
  updateContactServerSide: m.update,
  emitContactDeleted: vi.fn(),
}));
import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(
    new Request("https://example.com/api/contacts/c1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "c1" }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "u1", agencyId: "ag1" });
  m.update.mockResolvedValue({ id: "c1", contact: {} });
  m.companies.clear();
  m.companies.set("companies/co1", { subAccountId: "sa1", name: "Acme" });
  m.companies.set("companies/co-other", { subAccountId: "sa2", name: "Theirs" });
});

it("links a same-tenant company and pins `company` to its name", async () => {
  const res = await patch({ company: "typed junk", companyId: "co1" });
  expect(res.status).toBe(200);
  expect(m.update).toHaveBeenCalledWith(
    expect.objectContaining({
      patch: expect.objectContaining({ companyId: "co1", company: "Acme" }),
    }),
  );
});

it("refuses a companyId from another sub-account", async () => {
  const res = await patch({ companyId: "co-other" });
  expect(res.status).toBe(400);
  expect(m.update).not.toHaveBeenCalled();
});

it("null companyId unlinks and keeps the free text sent", async () => {
  const res = await patch({ company: "Acme Ltd", companyId: null });
  expect(res.status).toBe(200);
  expect(m.update).toHaveBeenCalledWith(
    expect.objectContaining({
      patch: expect.objectContaining({ companyId: null, company: "Acme Ltd" }),
    }),
  );
});
