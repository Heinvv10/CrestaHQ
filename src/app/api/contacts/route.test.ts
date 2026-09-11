import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({ data: () => ({ agencyId: "ag1" }) }),
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
});

it("creates a phone-only contact with an empty name", async () => {
  const res = await post({ subAccountId: "sa1", phone: "+27821234567" });
  expect(res.status).toBe(201);
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ name: "", email: "", phone: "+27821234567" }),
  );
});

it("refuses a contact with no name, phone or email", async () => {
  const res = await post({ subAccountId: "sa1", name: " ", company: "Acme" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("Enter a name, phone or email");
  expect(m.create).not.toHaveBeenCalled();
});
