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
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: m.create,
}));
import { POST } from "./route";

const post = (contacts: unknown[]) =>
  POST(
    new Request("https://example.com/api/contacts/import", {
      method: "POST",
      body: JSON.stringify({ subAccountId: "sa1", contacts }),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ uid: "u1", agencyId: "ag1" });
  m.create.mockResolvedValue({ id: "c1", contact: {} });
});

it("imports a phone-only row and reports an all-empty row", async () => {
  const res = await post([
    { phone: "+27821234567" },
    { name: " ", email: "", company: "Acme" },
  ]);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    created: 1,
    errors: [{ index: 1, message: "Enter a name, phone or email" }],
  });
  expect(m.create).toHaveBeenCalledTimes(1);
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ name: "", email: "", phone: "+27821234567" }),
  );
});
