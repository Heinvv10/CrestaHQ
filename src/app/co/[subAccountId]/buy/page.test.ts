import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { checkoutSlugError } from "@/types/checkout-pages";

/**
 * The public catalog at /co/[sa]/buy through its real loader: only products
 * on sale right now (gate, price, rail), never a slug two products share, and
 * 404 with the gate off. A checkout page slugged "buy" from before the slug
 * was reserved still renders here, since this static folder shadows it.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: CatalogPage } = await import("./page");

const SA = "sa1";
const SUB = {
  agencyId: "ag1",
  name: "Fixture",
  sellOnlineEnabledByAgency: true,
  paymentsEnabledByAgency: true,
  stripeConnectionMeta: { ready: true },
};
const product = (id: string, over: Record<string, unknown> = {}) =>
  mem.seed(`products/${id}`, {
    subAccountId: SA,
    name: `Product ${id}`,
    unitPriceCents: 1_000,
    currency: "USD",
    active: true,
    sellOnline: true,
    slug: `slug-${id}`,
    ...over,
  });

const tree = async () =>
  (await CatalogPage({
    params: Promise.resolve({ subAccountId: SA }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
const render = async () => renderToStaticMarkup(await tree());

beforeEach(() => {
  mem.clear();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  mem.seed(`subAccounts/${SA}`, SUB);
});

it("lists what is for sale right now, each linking to its buy page", async () => {
  product("a");
  product("off", { sellOnline: false });
  product("archived", { active: false });
  product("free", { unitPriceCents: 0 });
  product("zar", { currency: "XYZ" });
  product("dup1", { slug: "shared" });
  product("dup2", { slug: "shared" });
  const html = await render();
  expect(html).toContain(`href="/co/${SA}/buy/slug-a"`);
  for (const hidden of ["Product off", "Product archived", "Product free", "Product zar", "Product dup1", "Product dup2"]) {
    expect(html).not.toContain(hidden);
  }
});

it("gate off → 404", async () => {
  product("a");
  mem.seed(`subAccounts/${SA}`, { ...SUB, sellOnlineEnabledByAgency: false });
  await expect(tree()).rejects.toMatchObject({ digest: expect.stringMatching(/404/) });
});

it("a checkout page slugged 'buy' from before the reservation still renders", async () => {
  product("main", { sellOnline: false });
  mem.seed(`subAccounts/${SA}`, SUB);
  mem.seed(`subAccounts/${SA}/checkoutPages/cp1`, {
    slug: "buy",
    name: "Legacy buy page",
    headline: "Legacy offer",
    status: "published",
    productId: "main",
    bumpProductIds: [],
    collectFields: [],
    autoTags: [],
    pipelineStageId: null,
    successUrl: null,
  });
  expect(await render()).toContain("Legacy offer");
});

it("a new checkout page can't take the slug 'buy'", () => {
  expect(checkoutSlugError("buy")).not.toBeNull();
});
