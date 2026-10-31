import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A checkout page made from a product never takes a reserved slug: one would
 * be shadowed by a static /co/[sa]/… route (upstream 1.0.54 reserves "buy"
 * for the products' buy pages; "thanks" was already reserved).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { ensureCheckoutPageForProduct } = await import("./create-from-product");

const make = (label: string) =>
  ensureCheckoutPageForProduct({
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
    productId: "pr1",
    ownerKey: `funnel:${label}`,
    label,
  });
const slugOf = (id: string) => mem.read(`subAccounts/sa1/checkoutPages/${id}`)!.slug;

beforeEach(() => {
  mem.clear();
  mem.seed("products/pr1", { subAccountId: "sa1", agencyId: "ag1", name: "Fibre", description: "", unitPriceCents: 100, currency: "ZAR", active: true });
});

describe("ensureCheckoutPageForProduct — slug", () => {
  it("a reserved label gets the next free slug", async () => {
    expect(slugOf(await make("Thanks"))).toBe("thanks-2");
  });

  it("a taken slug gets a counter", async () => {
    mem.seed("subAccounts/sa1/checkoutPages/cp0", { subAccountId: "sa1", slug: "offer" });
    expect(slugOf(await make("Offer"))).toBe("offer-2");
  });

  it("a free slug is used as is", async () => {
    expect(slugOf(await make("Offer"))).toBe("offer");
  });
});
