import { beforeEach, expect, it, vi } from "vitest";

// Named apart from route.test.ts (feat/sp1-nameless-contact) so the two
// branches don't collide on one file.
const m = vi.hoisted(() => ({
  access: vi.fn(),
  create: vi.fn(),
  companies: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () =>
        path.startsWith("companies/")
          ? {
              exists: m.companies.has(path),
              data: () => m.companies.get(path),
            }
          : { data: () => ({ agencyId: "ag1" }) },
    }),
  }),
}));
vi.mock("@/lib/custom-fields/load-defs", () => ({
  loadCustomFieldDefs: async () => [],
}));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: m.create,
}));
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("https://example.com/api/contacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "u1", agencyId: "ag1" });
  m.create.mockResolvedValue({ id: "c1", contact: {} });
  m.companies.clear();
  m.companies.set("companies/co1", { subAccountId: "sa1", name: "Acme" });
  m.companies.set("companies/co-other", { subAccountId: "sa2", name: "Theirs" });
});

it("links a same-tenant company and pins `company` to its name", async () => {
  const res = await post({
    subAccountId: "sa1",
    name: "Thandi",
    company: "typed junk",
    companyId: "co1",
  });
  expect(res.status).toBe(201);
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ companyId: "co1", company: "Acme" }),
  );
});

it("refuses a companyId that belongs to another sub-account", async () => {
  const res = await post({
    subAccountId: "sa1",
    name: "Thandi",
    companyId: "co-other",
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("Company not found");
  expect(m.create).not.toHaveBeenCalled();
});

it("keeps free text unlinked when no companyId is sent", async () => {
  const res = await post({ subAccountId: "sa1", name: "Thandi", company: "Nowhere" });
  expect(res.status).toBe(201);
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ companyId: null, company: "Nowhere" }),
  );
});
