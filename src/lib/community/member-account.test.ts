import { beforeEach, describe, expect, it, vi } from "vitest";

import { SA, mem } from "@/test/paystack-links-harness";

/**
 * `ensureMember` over the real contacts service on an in-memory Firestore:
 * find-or-create must be idempotent under concurrency, and must keep finding
 * members created before the deterministic-id claim (random ids).
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const { ensureMember } = await import("./member-account");

const members = () => mem.list(`subAccounts/${SA}/members`);

beforeEach(() => {
  mem.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Acme", createdByUid: "u1" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ensureMember", () => {
  it("concurrent first sightings of one email create ONE member and ONE contact, linked", async () => {
    const got = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        ensureMember({ subAccountId: SA, email: i % 2 ? " Buyer@Example.com " : "buyer@example.com", displayName: "Bea" }),
      ),
    );

    expect(new Set(got.map((m) => m.id)).size).toBe(1);
    expect(members()).toHaveLength(1);
    expect(mem.list("contacts")).toHaveLength(1);
    expect(members()[0]).toMatchObject({
      email: "buyer@example.com", status: "active", subAccountId: SA, agencyId: "ag1", contactId: mem.list("contacts")[0].id,
    });
  });

  it("a later call returns the same member", async () => {
    const a = await ensureMember({ subAccountId: SA, email: "buyer@example.com" });
    const b = await ensureMember({ subAccountId: SA, email: "buyer@example.com" });
    expect(b.id).toBe(a.id);
    expect(members()).toHaveLength(1);
  });

  it("finds a member created earlier under a random id, and makes no second one", async () => {
    mem.seed(`subAccounts/${SA}/members/oldRandomId`, {
      subAccountId: SA, agencyId: "ag1", email: "buyer@example.com", status: "active", contactId: "c9",
    });
    const m = await ensureMember({ subAccountId: SA, email: "Buyer@example.com" });

    expect(m.id).toBe("oldRandomId");
    expect(members()).toHaveLength(1);
    expect(mem.list("contacts")).toHaveLength(0);
  });

  it("the same email in another sub-account is another member", async () => {
    mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Other", createdByUid: "u1" });
    const a = await ensureMember({ subAccountId: SA, email: "buyer@example.com" });
    const b = await ensureMember({ subAccountId: "sa2", email: "buyer@example.com" });
    expect(a.id).not.toBe(b.id);
    expect(mem.list("subAccounts/sa2/members")).toHaveLength(1);
  });

  it("reuses an existing contact with that email instead of creating one", async () => {
    mem.seed("contacts/c1", { subAccountId: SA, agencyId: "ag1", email: "buyer@example.com" });
    const m = await ensureMember({ subAccountId: SA, email: "buyer@example.com" });
    expect(m.contactId).toBe("c1");
    expect(mem.list("contacts")).toHaveLength(1);
  });

  it("a contact failure doesn't block the member (login is not blocked)", async () => {
    const real = mem.db.collection;
    vi.spyOn(mem.db, "collection").mockImplementation((path: string) => {
      if (path === "contacts") throw new Error("contacts down");
      return real(path);
    });
    const m = await ensureMember({ subAccountId: SA, email: "buyer@example.com" });
    expect(m).toMatchObject({ status: "active", contactId: null });
    expect(members()).toHaveLength(1);
  });

  it("a create that fails for any reason but 'already exists' is thrown, not mistaken for a race", async () => {
    const real = mem.db.doc;
    vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const ref = real(path);
      return path.includes("/members/")
        ? { ...ref, create: async () => { throw Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }); } }
        : ref;
    });
    await expect(ensureMember({ subAccountId: SA, email: "buyer@example.com" })).rejects.toThrow(/UNAVAILABLE/);
    expect(members()).toHaveLength(0);
    expect(mem.list("contacts")).toHaveLength(0);
  });

  it("an unknown sub-account throws before creating anything", async () => {
    await expect(ensureMember({ subAccountId: "nope", email: "a@b.co" })).rejects.toThrow(/not found/);
    expect(mem.list("subAccounts/nope/members")).toHaveLength(0);
  });
});
