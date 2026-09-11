import { beforeEach, expect, it, vi } from "vitest";

/**
 * A writer that has no `companyId` field of its own (the public API PATCH)
 * must not leave a stale link behind when it rewrites `company`.
 */
const m = vi.hoisted(() => ({ update: vi.fn(), existing: {} as Record<string, unknown> }));
const ref = {
  path: "contacts/contact",
  get: async () => ({ exists: true, id: "contact", data: () => m.existing }),
  update: m.update,
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({ doc: () => ref }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn() }));
vi.mock("@/lib/api/serializers/contacts", () => ({
  serializeContactForApi: () => ({ id: "contact" }),
}));
import { updateContactServerSide } from "./contacts-service";

beforeEach(() => {
  m.update.mockReset();
  m.existing = {
    subAccountId: "sa",
    agencyId: "agency",
    mode: "live",
    company: "Acme",
    companyId: "co1",
  };
});

it("renaming `company` with no companyId in the patch drops the link", async () => {
  await updateContactServerSide({
    contactId: "contact",
    patch: { company: "Acme Ltd" },
  });
  expect(m.update).toHaveBeenCalledWith(
    expect.objectContaining({ company: "Acme Ltd", companyId: null }),
  );
});

it("sending the same `company` string keeps the link", async () => {
  await updateContactServerSide({
    contactId: "contact",
    patch: { company: "Acme" },
  });
  const written = m.update.mock.calls[0][0] as Record<string, unknown>;
  expect(written).not.toHaveProperty("companyId");
});

it("a patch that names its companyId is written as sent", async () => {
  await updateContactServerSide({
    contactId: "contact",
    patch: { company: "Other", companyId: "co2" },
  });
  expect(m.update).toHaveBeenCalledWith(
    expect.objectContaining({ company: "Other", companyId: "co2" }),
  );
});
