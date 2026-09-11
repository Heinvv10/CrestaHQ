import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  txUpdate: vi.fn(),
  existing: {} as Record<string, unknown>,
}));
const targetRef = { path: "contacts/c1" };
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({ path }),
    collection: () => {
      const q = { where: () => q, limit: () => q, doc: () => ({ path: "contacts/new" }) };
      return q;
    },
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (r: unknown) =>
          r && typeof r === "object" && "path" in r
            ? { exists: false }
            : {
                size: 1,
                docs: [{ id: "c1", ref: targetRef, data: () => m.existing }],
              },
        update: m.txUpdate,
        delete: vi.fn(),
        set: vi.fn(),
      }),
  }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn() }));
vi.mock("@/lib/api/serializers/contacts", () => ({
  serializeContactForApi: () => ({ id: "c1" }),
}));
import { upsertContactByPhone } from "./contact-upsert";

const base = {
  subAccountId: "sa",
  agencyId: "agency",
  mode: "live" as const,
  createdByUid: "u1",
  phone: "+27821234567",
  customFields: {},
  requiredCustomFields: [],
  tagsAdd: [],
  tagsRemove: [],
};

beforeEach(() => {
  m.txUpdate.mockReset();
  m.existing = {
    subAccountId: "sa",
    agencyId: "agency",
    mode: "live",
    phone: "+27821234567",
    company: "Acme",
    companyId: "co1",
    tags: [],
  };
});

it("upsert renaming `company` on a linked contact drops the link", async () => {
  const out = await upsertContactByPhone({ ...base, fields: { company: "Acme Ltd" } });
  expect(out.kind).toBe("updated");
  expect(m.txUpdate).toHaveBeenCalledWith(
    targetRef,
    expect.objectContaining({ company: "Acme Ltd", companyId: null }),
  );
});

it("upsert that leaves `company` alone keeps the link", async () => {
  await upsertContactByPhone({ ...base, fields: { name: "Thandi" } });
  const written = m.txUpdate.mock.calls[0][1] as Record<string, unknown>;
  expect(written).not.toHaveProperty("companyId");
});
