import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Sell online through the real products routes (upstream 1.0.54 F1): the
 * agency gate refuses enabling with 403 `gate_off`, a slug another product or
 * a checkout page uses is refused, the price and currency are validated at
 * the server boundary, and enabling needs a ready rail (Paystack is ZAR only).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({
    getUser: async () => ({ customClaims: { status: "active", agencyId: "ag1", agencyRole: "owner" } }),
  }),
}));

const { POST } = await import("./route");
const { PATCH, DELETE } = await import("./[productId]/route");

const STRIPE = { ready: true };
const PAYSTACK = { keyLast4: "45a2", currencies: ["ZAR"], livemode: false, webhookSeenAt: null, webhookUrl: null, connectedAt: new Date() };
const SELLING_SUB = { agencyId: "ag1", sellOnlineEnabledByAgency: true, paymentsEnabledByAgency: true, stripeConnectionMeta: STRIPE };
const PRODUCT = { subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", name: "Fibre 100", description: "", unitPriceCents: 49_900, currency: "ZAR", active: true };

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://app.test/api/sub-accounts/sa1/products${path}`, {
    method,
    headers: { "x-user-uid": "u1", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const create = (body: Record<string, unknown>) => POST(req("POST", "", body), { params: Promise.resolve({ id: "sa1" }) });
// The handler's inferred type admits undefined; every path returns a response.
const patch = async (body: Record<string, unknown>, productId = "pr1") =>
  (await PATCH(req("PATCH", `/${productId}`, body), { params: Promise.resolve({ id: "sa1", productId }) }))!;
const products = () => mem.list("products");

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", SELLING_SUB);
  mem.seed("products/pr1", PRODUCT);
});

describe("gate", () => {
  it("gate off → enabling refused 403 gate_off, nothing written (PATCH)", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, sellOnlineEnabledByAgency: false });
    const res = await patch({ sellOnline: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "gate_off" });
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("gate off → creating a product for sale refused 403, no product created (POST)", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, sellOnlineEnabledByAgency: false });
    const res = await create({ name: "Fibre 200", unitPriceCents: 69_900, currency: "ZAR", sellOnline: true });
    expect(res.status).toBe(403);
    expect(products()).toHaveLength(1);
  });

  it("gate off → a slug change on a product already for sale refused", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, sellOnlineEnabledByAgency: false });
    mem.seed("products/pr1", { ...PRODUCT, sellOnline: true, slug: "fibre-100" });
    expect((await patch({ slug: "fibre-new" })).status).toBe(403);
    expect(mem.read("products/pr1")!.slug).toBe("fibre-100");
  });

  it("gate off → the UI's round-trip of unchanged values is a no-op 200", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, sellOnlineEnabledByAgency: false });
    const res = await patch({ sellOnline: false, publicDescription: "", delivery: { type: "none" }, checkoutPageId: null });
    expect(res.status).toBe(200);
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("gate off → taking a product off sale is still allowed", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, sellOnlineEnabledByAgency: false });
    mem.seed("products/pr1", { ...PRODUCT, sellOnline: true, slug: "fibre-100" });
    expect((await patch({ sellOnline: false })).status).toBe(200);
    expect(mem.read("products/pr1")!.sellOnline).toBe(false);
  });

  it("POST gate on + Stripe ready → created for sale with a minted slug", async () => {
    const res = await create({ name: "Fibre 200", unitPriceCents: 69_900, currency: "ZAR", sellOnline: true });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(mem.read(`products/${id}`)).toMatchObject({ sellOnline: true, slug: "fibre-200", unitPriceCents: 69_900 });
  });

  it("checks run on the product as it is at commit: a price set to 0 in parallel → enabling refused", async () => {
    const real = mem.db.runTransaction.bind(mem.db);
    vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async (fn) => {
      mem.seed("products/pr1", { ...PRODUCT, unitPriceCents: 0 });
      return real(fn);
    });
    expect((await patch({ sellOnline: true })).status).toBe(400);
    expect(mem.read("products/pr1")!.sellOnline).toBeUndefined();
  });

  it("gate on + Stripe ready → enabled, slug minted from the name", async () => {
    const res = await patch({ sellOnline: true });
    expect(res.status).toBe(200);
    expect(mem.read("products/pr1")).toMatchObject({ sellOnline: true, slug: "fibre-100" });
  });
});

describe("slug", () => {
  it("a slug another product uses → 409", async () => {
    mem.seed("products/pr2", { ...PRODUCT, name: "Other", slug: "fast" });
    const res = await patch({ sellOnline: true, slug: "fast" });
    expect(res.status).toBe(409);
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("a slug a checkout page in the same sub-account uses → 409", async () => {
    mem.seed("subAccounts/sa1/checkoutPages/cp1", { subAccountId: "sa1", slug: "fast", status: "published" });
    const res = await patch({ sellOnline: true, slug: "fast" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/checkout page/);
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("the same slug in ANOTHER sub-account is free", async () => {
    mem.seed("products/px", { ...PRODUCT, subAccountId: "sa2", slug: "fast" });
    mem.seed("subAccounts/sa2/checkoutPages/cp1", { subAccountId: "sa2", slug: "fast" });
    expect((await patch({ sellOnline: true, slug: "fast" })).status).toBe(200);
    expect(mem.read("products/pr1")!.slug).toBe("fast");
  });

  it("a minted slug skips one a checkout page uses", async () => {
    mem.seed("subAccounts/sa1/checkoutPages/cp1", { subAccountId: "sa1", slug: "fibre-100" });
    expect((await patch({ sellOnline: true })).status).toBe(200);
    expect(mem.read("products/pr1")!.slug).toBe("fibre-100-2");
  });

  it.each([["buy"], ["thanks"], ["a"], ["-"]])("slug %j → 400", async (slug) => {
    expect((await patch({ sellOnline: true, slug })).status).toBe(400);
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });
});

describe("price and currency", () => {
  it.each([
    ["price 0", { unitPriceCents: 0 }],
    ["price over the cap", { unitPriceCents: 100_000_001 }],
    ["a currency outside the list", { currency: "XYZ" }],
  ])("enabling with %s → 400", async (_label, fields) => {
    const res = await patch({ sellOnline: true, ...fields });
    expect(res.status).toBe(400);
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("a product for sale can't have its price set to 0", async () => {
    mem.seed("products/pr1", { ...PRODUCT, sellOnline: true, slug: "fibre-100" });
    expect((await patch({ unitPriceCents: 0 })).status).toBe(400);
    expect(mem.read("products/pr1")!.unitPriceCents).toBe(49_900);
  });

  it("a product NOT for sale keeps the old catalog rules (price 0 allowed)", async () => {
    expect((await patch({ unitPriceCents: 0 })).status).toBe(200);
    expect(mem.read("products/pr1")!.unitPriceCents).toBe(0);
  });

  it("POST: a product created for sale at price 0 → 400, none created", async () => {
    const res = await create({ name: "Free thing", currency: "ZAR", sellOnline: true });
    expect(res.status).toBe(400);
    expect(products()).toHaveLength(1);
  });
});

describe("rail", () => {
  it("Paystack-only workspace, USD product → enabling refused naming ZAR", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, stripeConnectionMeta: null, paystackConnectionMeta: PAYSTACK });
    const res = await patch({ sellOnline: true, currency: "USD" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "no_pay_rail", error: expect.stringMatching(/only takes ZAR/) });
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("Paystack-only workspace, ZAR product → enabled", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, stripeConnectionMeta: null, paystackConnectionMeta: PAYSTACK });
    expect((await patch({ sellOnline: true })).status).toBe(200);
    expect(mem.read("products/pr1")!.sellOnline).toBe(true);
  });

  it("Paystack-only: a ZAR product for sale can't be moved to USD", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, stripeConnectionMeta: null, paystackConnectionMeta: PAYSTACK });
    mem.seed("products/pr1", { ...PRODUCT, sellOnline: true, slug: "fibre-100" });
    expect((await patch({ currency: "USD" })).status).toBe(400);
    expect(mem.read("products/pr1")!.currency).toBe("ZAR");
  });

  it("no rail at all → enabling refused", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, stripeConnectionMeta: null });
    expect((await patch({ sellOnline: true })).status).toBe(400);
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });
});

describe("delivery and ids", () => {
  it.each([
    ["http", "http://example.com/file.pdf"],
    ["localhost", "https://localhost/file.pdf"],
    ["an IP literal", "https://10.0.0.1/file.pdf"],
    ["a quote", 'https://example.com/a"b'],
    ["javascript:", "javascript:alert(1)"],
  ])("a download link that is %s → 400", async (_label, url) => {
    expect((await patch({ sellOnline: true, delivery: { type: "download", url } })).status).toBe(400);
    expect(mem.read("products/pr1")).toEqual(PRODUCT);
  });

  it("a public https download link → stored", async () => {
    expect((await patch({ sellOnline: true, delivery: { type: "download", url: "https://example.com/guide.pdf" } })).status).toBe(200);
    expect(mem.read("products/pr1")!.delivery).toEqual({ type: "download", url: "https://example.com/guide.pdf" });
  });

  it("a community group id that is a path → 400, even when a doc exists at that path", async () => {
    mem.seed("subAccounts/sa1", { ...SELLING_SUB, communityEnabledByAgency: true });
    mem.seed("subAccounts/sa1/communityGroups/g1/courses/c1", { title: "Course" });
    const res = await patch({ sellOnline: true, delivery: { type: "community", communityGroupId: "g1/courses/c1" } });
    expect(res.status).toBe(400);
  });

  it("a product id that is a path → 404, the doc at that path untouched", async () => {
    mem.seed("products/pr1/x/y", { ...PRODUCT, name: "Nested" });
    expect((await patch({ name: "X" }, "pr1/x/y")).status).toBe(404);
    expect(mem.read("products/pr1/x/y")!.name).toBe("Nested");
  });

  it("a checkout page that sells a different product → 400", async () => {
    mem.seed("products/pr1", { ...PRODUCT, sellOnline: true, slug: "fibre-100" });
    mem.seed("subAccounts/sa1/checkoutPages/cp1", { subAccountId: "sa1", slug: "offer", productId: "other", status: "published" });
    expect((await patch({ checkoutPageId: "cp1" })).status).toBe(400);
  });
});

describe("archive", () => {
  it("archiving a product for sale bumps publicVersion", async () => {
    mem.seed("products/pr1", { ...PRODUCT, sellOnline: true, slug: "fibre-100", publicVersion: 3 });
    const res = (await DELETE(req("DELETE", "/pr1"), { params: Promise.resolve({ id: "sa1", productId: "pr1" }) }))!;
    expect(res.status).toBe(200);
    expect(mem.read("products/pr1")).toMatchObject({ active: false, publicVersion: 4 });
  });
});
