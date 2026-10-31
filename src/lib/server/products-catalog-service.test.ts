import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The public catalog lists a product only when it is on sale, its price is
 * valid and a rail can charge its currency now: a Paystack-only workspace
 * never lists a USD product.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { listSellableProducts } = await import("./products-catalog-service");

const ON_SALE = { subAccountId: "sa1", agencyId: "ag1", description: "", active: true, sellOnline: true, unitPriceCents: 100, currency: "ZAR" };
const PAYSTACK_ONLY = {
  sellOnlineEnabledByAgency: true,
  paymentsEnabledByAgency: true,
  paystackConnectionMeta: { keyLast4: "45a2", currencies: ["ZAR"], livemode: false, webhookSeenAt: null, webhookUrl: null, connectedAt: new Date() },
};
const names = async (sub: Record<string, unknown>) => (await listSellableProducts("sa1", sub)).map((p) => p.name);

beforeEach(() => {
  mem.clear();
  mem.seed("products/a", { ...ON_SALE, name: "B zar", slug: "b-zar" });
  mem.seed("products/b", { ...ON_SALE, name: "A zar", slug: "a-zar" });
  mem.seed("products/c", { ...ON_SALE, name: "Usd", slug: "usd", currency: "USD" });
  mem.seed("products/d", { ...ON_SALE, name: "Archived", slug: "archived", active: false });
  mem.seed("products/e", { ...ON_SALE, name: "No slug" });
  mem.seed("products/f", { ...ON_SALE, name: "Free", slug: "free", unitPriceCents: 0 });
  mem.seed("products/g", { ...ON_SALE, name: "Not for sale", slug: "nfs", sellOnline: false });
  mem.seed("products/h", { ...ON_SALE, name: "Other tenant", slug: "other", subAccountId: "sa2" });
});

describe("listSellableProducts", () => {
  it("Paystack-only: ZAR products on sale with a price, sorted by name", async () => {
    expect(await names(PAYSTACK_ONLY)).toEqual(["A zar", "B zar"]);
  });

  it("Stripe ready: the USD product is listed too", async () => {
    expect(await names({ ...PAYSTACK_ONLY, stripeConnectionMeta: { ready: true } })).toEqual(["A zar", "B zar", "Usd"]);
  });

  it("gate off → nothing", async () => {
    expect(await names({ ...PAYSTACK_ONLY, sellOnlineEnabledByAgency: false })).toEqual([]);
  });
});
