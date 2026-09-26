import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * find_contacts in a sub-account bigger than its 500-contact scan: exact
 * email / phone / name matches reach every contact, the partial scan takes
 * the newest contacts (not the first 500 by doc id), and the text says what
 * was searched. Real execute() over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { getCapability } = await import("../capabilities");

const base = { email: "a@example.com", displayName: "A", agencyId: "ag1", subAccountId: "sa1" };
const admin = { ...base, uid: "u_admin", subAccountRole: "admin" };
const rep = { ...base, uid: "u_rep", subAccountRole: "collaborator" };
const tenant = { subAccountId: "sa1", agencyId: "ag1" };
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

const run = (ctx: typeof admin, query: string) =>
  getCapability("find_contacts")!.execute(ctx, { query }).then((r) => r.resultText);

function seedFiller(n: number) {
  // Doc ids a000... sort before the target; createdAt from day 10 on, so all are newer than it.
  for (let i = 0; i < n; i++) {
    mem.seed(`contacts/a${String(i).padStart(3, "0")}`, { ...tenant, territoryId: "north", name: `Filler ${i}`, createdAt: day(10 + i) });
  }
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", defaultPhoneCountry: "ZA", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u_rep", { role: "collaborator", assignedTerritoryIds: ["north"] });
});

describe("find_contacts beyond the 500-contact scan", () => {
  beforeEach(() => {
    seedFiller(600);
    // Last by doc id AND oldest: outside both the old doc-id window and the newest-500 scan.
    mem.seed("contacts/zzz_old", { ...tenant, territoryId: "north", name: "Jane Oldest", email: "jane@example.com", phone: "+27821234567", createdAt: day(0) });
  });

  it("finds it by exact email, case-insensitively for a lowercase-stored email", async () => {
    expect(await run(admin, "jane@example.com")).toContain("Jane Oldest \u2014 id: zzz_old");
    expect(await run(admin, "Jane@Example.com")).toContain("id: zzz_old");
  });

  it("finds a mixed-case stored email searched with the same casing", async () => {
    mem.seed("contacts/zzz_mixed", { ...tenant, territoryId: "north", name: "Mixed Case", email: "Jane@Example.com", createdAt: day(1) });
    expect(await run(admin, "Jane@Example.com")).toContain("id: zzz_mixed");
  });

  it("finds it by phone in E.164 or national format (workspace default country)", async () => {
    expect(await run(admin, "+27821234567")).toContain("id: zzz_old");
    expect(await run(admin, "082 123 4567")).toContain("id: zzz_old");
  });

  it("finds it by exact full name", async () => {
    expect(await run(admin, "Jane Oldest")).toContain("id: zzz_old");
  });

  it("the partial scan covers the newest contacts, not the first 500 by doc id", async () => {
    mem.seed("contacts/zzz_new", { ...tenant, territoryId: "north", name: "Brand New Lead", createdAt: day(999) });
    const text = await run(admin, "brand new");
    expect(text).toContain("id: zzz_new");
    // A partial query for the old contact is honestly reported as not searched there.
    expect(await run(admin, "oldest")).toBe(
      "No contacts matched \u201coldest\u201d. Exact matches (email, phone and full name as stored) were checked across all contacts; partial matches only among the 500 most recently created (a contact with no creation date is only matched exactly).",
    );
  });

  it("says the partial scan was capped under a result list too", async () => {
    const text = await run(admin, "jane@example.com");
    expect(text).toMatch(/\nExact matches \(email, phone and full name as stored\) were checked across all contacts; partial matches only among the 500 most recently created \(a contact with no creation date is only matched exactly\)\.$/);
    expect(text).not.toContain("indexed");
  });

  it("an exact match stays inside the caller's territories", async () => {
    mem.seed("contacts/zzz_south", { ...tenant, territoryId: "south", name: "Sam South", email: "sam@example.com", createdAt: day(0) });
    expect(await run(rep, "sam@example.com")).toMatch(/^No contacts matched/);
    expect(await run(admin, "sam@example.com")).toContain("id: zzz_south");
    expect(await run(rep, "jane@example.com")).toContain("id: zzz_old");
  });
});

describe("find_contacts for a territory-scoped caller", () => {
  it("other territories' newer contacts can't use up the scan (breaker repro)", async () => {
    for (let i = 0; i < 2500; i++) {
      mem.seed(`contacts/s${String(i).padStart(4, "0")}`, { ...tenant, territoryId: "south", name: `South ${i}`, createdAt: day(10 + i) });
    }
    mem.seed("contacts/zz_rep", { ...tenant, territoryId: "north", name: "Zedekiah Rep", createdAt: day(0) });
    const text = await run(rep, "zedekiah");
    expect(text).toContain("Zedekiah Rep \u2014 id: zz_rep");
    expect(text).not.toContain("South");
  });

  it("names the territory scan in the capped text", async () => {
    seedFiller(600); // all north
    expect(await run(rep, "nobody")).toBe(
      "No contacts matched \u201cnobody\u201d. Exact matches (email, phone and full name as stored) were checked across all contacts; partial matches only among 500 contacts in your territories.",
    );
  });

  it("an exact match isn't crowded out by 40 invisible ones", async () => {
    seedFiller(600); // north, ahead of z_mine in doc-id order: it is outside the rep's partial scan
    for (let i = 0; i < 40; i++) mem.seed(`contacts/b${i}`, { ...tenant, territoryId: "south", name: "Same Name", createdAt: day(1) });
    mem.seed("contacts/z_mine", { ...tenant, territoryId: "north", name: "Same Name", createdAt: day(0) });
    expect(await run(rep, "Same Name")).toContain("id: z_mine");
  });
});

describe("find_contacts in a small sub-account", () => {
  it("claims no cap when every contact was scanned", async () => {
    seedFiller(3);
    expect(await run(admin, "nobody")).toBe("No contacts matched \u201cnobody\u201d.");
    const text = await run(admin, "filler");
    expect(text).toMatch(/^Contacts matching \u201cfiller\u201d \(3\):\n/);
    expect(text).not.toContain("most recently created");
  });

  it("lists a contact matched both exactly and partially once", async () => {
    seedFiller(3);
    mem.seed("contacts/b1", { ...tenant, territoryId: "north", name: "Filler Exact", email: "fe@example.com", createdAt: day(1) });
    const text = await run(admin, "fe@example.com");
    expect(text.match(/id: b1/g)).toHaveLength(1);
  });
});
