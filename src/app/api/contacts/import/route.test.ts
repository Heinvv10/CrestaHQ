import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  create: vi.fn(),
  // Docs already in Firestore, keyed by field:value (e.g. "email:a@b.com"),
  // so a test can seed what the dedup lookup should find.
  existingByKey: new Map<string, Record<string, unknown>>(),
  // subAccounts/{id}.defaultPhoneCountry — settable per test so phone
  // normalization can be exercised with a non-US country.
  defaultPhoneCountry: null as string | null,
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({
        data: () => ({ agencyId: "ag1", defaultPhoneCountry: m.defaultPhoneCountry }),
      }),
    }),
    collection: (name: string) => ({
      where(field: string, op: string, value: unknown) {
        const filters: { field: string; op: string; value: unknown }[] = [
          { field, op, value },
        ];
        const builder = {
          where(f: string, o: string, v: unknown) {
            filters.push({ field: f, op: o, value: v });
            return builder;
          },
          async get() {
            if (name !== "contacts") return { docs: [] };
            const docs = [...m.existingByKey.values()].filter((data) =>
              filters.every(({ field: f, op: o, value: v }) => {
                if (o === "==") return data[f] === v;
                if (o === "in" && Array.isArray(v)) return v.includes(data[f]);
                return false;
              }),
            );
            return { docs: docs.map((data) => ({ data: () => data })) };
          },
        };
        return builder;
      },
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
  m.existingByKey.clear();
  m.defaultPhoneCountry = null;
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
    skipped: 0,
    errors: [{ index: 1, message: "Enter a name, phone or email" }],
  });
  expect(m.create).toHaveBeenCalledTimes(1);
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ name: "", email: "", phone: "+27821234567" }),
  );
});

it("skips a row matching an existing contact's phone", async () => {
  m.existingByKey.set("existing1", {
    subAccountId: "sa1",
    email: "",
    phone: "+27821234567",
  });
  const res = await post([{ name: "Jane", phone: "+27821234567" }]);
  expect(await res.json()).toEqual({
    created: 0,
    skipped: 1,
    errors: [{ index: 0, message: "Skipped — duplicate contact", duplicate: true }],
  });
  expect(m.create).not.toHaveBeenCalled();
});

it("skips a row matching an existing contact's email case-insensitively", async () => {
  // Reflects the post-fix state: import-created contacts are stored
  // lower-cased, so a re-import with different input casing still matches.
  m.existingByKey.set("existing1", {
    subAccountId: "sa1",
    email: "jane@example.com",
    phone: "",
  });
  const res = await post([{ name: "Jane", email: "JANE@Example.com" }]);
  expect(await res.json()).toEqual({
    created: 0,
    skipped: 1,
    errors: [{ index: 0, message: "Skipped — duplicate contact", duplicate: true }],
  });
  expect(m.create).not.toHaveBeenCalled();
});

it("re-importing the same CSV creates nothing the second time", async () => {
  const rows = [{ name: "Jane", email: "jane@example.com", phone: "+27821234567" }];
  const first = await post(rows);
  expect(await first.json()).toMatchObject({ created: 1, skipped: 0 });

  // Simulate the contact the first import wrote.
  m.existingByKey.set("c1", {
    subAccountId: "sa1",
    email: "jane@example.com",
    phone: "+27821234567",
  });

  const second = await post(rows);
  expect(await second.json()).toEqual({
    created: 0,
    skipped: 1,
    errors: [{ index: 0, message: "Skipped — duplicate contact", duplicate: true }],
  });
  expect(m.create).toHaveBeenCalledTimes(1);
});

it("dedupes two rows in the same CSV that share a phone", async () => {
  const res = await post([
    { name: "Jane", phone: "+27821234567" },
    { name: "Jane Duplicate", phone: "+27821234567" },
  ]);
  expect(await res.json()).toEqual({
    created: 1,
    skipped: 1,
    errors: [{ index: 1, message: "Skipped — duplicate contact", duplicate: true }],
  });
  expect(m.create).toHaveBeenCalledTimes(1);
});

it("normalises phone before the dedup lookup, so a local-format number matches the stored E.164 one", async () => {
  m.defaultPhoneCountry = "ZA";
  m.existingByKey.set("existing1", {
    subAccountId: "sa1",
    email: "",
    phone: "+27821234567",
  });
  // Same number, entered the way a ZA CSV would have it, not E.164.
  const res = await post([{ name: "Jane", phone: "082 123 4567" }]);
  expect(await res.json()).toEqual({
    created: 0,
    skipped: 1,
    errors: [{ index: 0, message: "Skipped — duplicate contact", duplicate: true }],
  });
  expect(m.create).not.toHaveBeenCalled();
});

it("lower-cases email before writing, so the contact it creates is itself matchable on re-import", async () => {
  const res = await post([{ name: "Jane", email: "Jane@EXAMPLE.com" }]);
  expect(await res.json()).toMatchObject({ created: 1, skipped: 0 });
  expect(m.create).toHaveBeenCalledWith(
    expect.objectContaining({ email: "jane@example.com" }),
  );
});
