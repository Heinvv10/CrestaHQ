import { describe, expect, it, vi } from "vitest";
import {
  deleteCompanyAndUnlinkContacts,
  resolveCompanyLink,
} from "./companies-service";

/** Minimal Admin-SDK stand-in: `doc()` reads from `rows`, contacts query
 *  returns every contact row whose companyId matches. */
function fakeDb(rows: Map<string, Record<string, unknown>>) {
  const batch = { update: vi.fn(), delete: vi.fn(), commit: vi.fn() };
  const ref = (path: string) => ({
    path,
    get: async () => ({ exists: rows.has(path), data: () => rows.get(path) }),
  });
  // Chainable where(): every equality clause must match, like Firestore.
  const queryOver = (name: string, clauses: [string, string][]) => ({
    where: (field: string, _op: string, value: string) =>
      queryOver(name, [...clauses, [field, value]]),
    get: async () => ({
      docs: [...rows.entries()]
        .filter(
          ([k, v]) =>
            k.startsWith(`${name}/`) && clauses.every(([f, val]) => v[f] === val),
        )
        .map(([k]) => ({ ref: ref(k) })),
    }),
  });
  const db = {
    doc: ref,
    collection: (name: string) => queryOver(name, []),
    batch: () => batch,
  };
  return { db: db as unknown as FirebaseFirestore.Firestore, batch };
}

describe("deleteCompanyAndUnlinkContacts", () => {
  it("clears companyId on every linked contact and deletes the company in one batch", async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ["companies/co1", { subAccountId: "sa", name: "Acme" }],
      ["contacts/a", { subAccountId: "sa", companyId: "co1", company: "Acme" }],
      ["contacts/b", { subAccountId: "sa", companyId: "co1", company: "Acme" }],
      ["contacts/other", { subAccountId: "sa", companyId: "co2", company: "Other" }],
    ]);
    const { db, batch } = fakeDb(rows);

    const unlinked = await deleteCompanyAndUnlinkContacts(db, "co1", "sa");

    expect(unlinked).toBe(2);
    expect(batch.update).toHaveBeenCalledTimes(2);
    for (const path of ["contacts/a", "contacts/b"]) {
      expect(batch.update).toHaveBeenCalledWith(
        expect.objectContaining({ path }),
        expect.objectContaining({ companyId: null }),
      );
    }
    expect(batch.delete).toHaveBeenCalledWith(
      expect.objectContaining({ path: "companies/co1" }),
    );
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });

  it("never touches a contact from another sub-account that points at the company", async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ["companies/co1", { subAccountId: "sa", name: "Acme" }],
      ["contacts/mine", { subAccountId: "sa", companyId: "co1" }],
      ["contacts/foreign", { subAccountId: "other-sa", companyId: "co1" }],
    ]);
    const { db, batch } = fakeDb(rows);

    const unlinked = await deleteCompanyAndUnlinkContacts(db, "co1", "sa");

    expect(unlinked).toBe(1);
    expect(batch.update).toHaveBeenCalledTimes(1);
    expect(batch.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: "contacts/mine" }),
      expect.anything(),
    );
    expect(batch.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "contacts/foreign" }),
      expect.anything(),
    );
  });

  it("chunks the unlink so 501 linked contacts still all get nulled", async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ["companies/co1", { subAccountId: "sa", name: "Acme" }],
    ]);
    for (let i = 0; i < 501; i++) {
      rows.set(`contacts/c${i}`, { subAccountId: "sa", companyId: "co1" });
    }
    const { db, batch } = fakeDb(rows);

    const unlinked = await deleteCompanyAndUnlinkContacts(db, "co1", "sa");

    expect(unlinked).toBe(501);
    expect(batch.update).toHaveBeenCalledTimes(501);
    expect(batch.delete).toHaveBeenCalledTimes(1);
    expect(batch.commit.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("resolveCompanyLink", () => {
  const rows = new Map<string, Record<string, unknown>>([
    ["companies/co1", { subAccountId: "sa", name: "Acme" }],
  ]);

  it("returns the company's name so the contact's free-text field stays in sync", async () => {
    const { db } = fakeDb(rows);
    await expect(resolveCompanyLink(db, "sa", "co1")).resolves.toEqual({
      ok: true,
      companyId: "co1",
      company: "Acme",
    });
  });

  it("refuses a company from another sub-account", async () => {
    const { db } = fakeDb(rows);
    await expect(resolveCompanyLink(db, "other-sa", "co1")).resolves.toEqual({
      ok: false,
      error: "Company not found",
    });
  });

  it("refuses an unknown company id", async () => {
    const { db } = fakeDb(rows);
    await expect(resolveCompanyLink(db, "sa", "nope")).resolves.toEqual({
      ok: false,
      error: "Company not found",
    });
  });
});
