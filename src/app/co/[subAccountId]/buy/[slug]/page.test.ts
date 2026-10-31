import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * The express buy page through its real loader: it renders only a product
 * that passes every sell-online re-check right now, 404s otherwise, asks a
 * Paystack buyer for an email (unit F3), hands an on-sale checkout page the
 * sale, and lets no stored accent or logo reach the markup unchecked.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: BuyPage, generateMetadata } = await import("./page");

const SA = "sa1";
const SUB = {
  agencyId: "ag1",
  name: "Fixture",
  sellOnlineEnabledByAgency: true,
  paymentsEnabledByAgency: true,
  stripeConnectionMeta: { ready: true },
};
const PRODUCT = {
  subAccountId: SA,
  name: "Fibre guide",
  description: "Everything about fibre.",
  unitPriceCents: 49_900,
  currency: "USD",
  active: true,
  sellOnline: true,
  slug: "fibre-guide",
  costCents: 1234,
};

const tree = async (slug = "fibre-guide", search: Record<string, string> = {}) =>
  (await BuyPage({
    params: Promise.resolve({ subAccountId: SA, slug }),
    searchParams: Promise.resolve(search),
  })) as ReactElement;
const render = async (slug?: string) => renderToStaticMarkup(await tree(slug));
const digestOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return String((err as { digest?: unknown }).digest ?? err);
  }
  return "rendered";
};

beforeEach(() => {
  mem.clear();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  mem.seed(`subAccounts/${SA}`, SUB);
  mem.seed("products/p1", PRODUCT);
});

it("renders the product from the doc, with the buy button", async () => {
  const html = await render();
  expect(html).toContain("Fibre guide");
  expect(html).toContain("$499.00");
  expect(html).toContain("Continue to payment");
});

describe("404 for anything not for sale", () => {
  it.each([
    ["gate off", () => mem.seed(`subAccounts/${SA}`, { ...SUB, sellOnlineEnabledByAgency: false })],
    ["archived", () => mem.seed("products/p1", { ...PRODUCT, active: false })],
    ["two products share the slug", () => mem.seed("products/p2", PRODUCT)],
    ["no rail for the currency", () => mem.seed(`subAccounts/${SA}`, { ...SUB, stripeConnectionMeta: { ready: false } })],
  ])("%s", async (_name, arrange) => {
    arrange();
    expect(await digestOf(tree())).toMatch(/404/);
  });
});

it("a Paystack-rail product asks for the buyer's email and names Paystack", async () => {
  mem.seed(`subAccounts/${SA}`, {
    ...SUB,
    stripeConnectionMeta: null,
    paystackConnectionMeta: { keyLast4: "45a2", currencies: ["ZAR"], connectedAt: new Date() },
  });
  mem.seed("products/p1", { ...PRODUCT, currency: "ZAR" });
  const html = await render();
  expect(html).toContain("Continue to payment");
  expect(html).toContain('type="email"');
  expect(html).toContain("securely by Paystack");
});

it("a Stripe-rail product asks for no email: Stripe's page collects it", async () => {
  const html = await render();
  expect(html).toContain("Continue to payment");
  expect(html).not.toContain('type="email"');
});

it("a published checkout page selling this product takes the buyer there", async () => {
  mem.seed("products/p1", { ...PRODUCT, checkoutPageId: "cp1" });
  mem.seed(`subAccounts/${SA}/checkoutPages/cp1`, { slug: "guide", productId: "p1", status: "published" });
  expect(await digestOf(tree())).toMatch(/NEXT_REDIRECT.*\/co\/sa1\/guide/);
});

it("a checkout page re-pointed at another product is never used", async () => {
  mem.seed("products/p1", { ...PRODUCT, checkoutPageId: "cp1" });
  mem.seed(`subAccounts/${SA}/checkoutPages/cp1`, { slug: "guide", productId: "other", status: "published" });
  expect(await render()).toContain("Continue to payment");
});

it("/buy/thanks is the legacy 'buy' checkout page's thank-you", async () => {
  expect(await render("thanks")).toContain("Payment received");
});

it("a stored accent or logo that isn't safe never reaches the page", async () => {
  mem.seed(`subAccounts/${SA}`, { ...SUB, logoUrl: "javascript:alert(1)" });
  mem.seed(`subAccounts/${SA}/aiAgent/web-chat`, { webChat: { accentColor: "red;background:url(https://evil.example/x)" } });
  const sent = stringsSentToClient(await tree());
  expect(sent.filter((s) => s.includes("evil.example") || s.includes("javascript:"))).toEqual([]);
  expect(await render()).toContain("#4f46e5");
});

it("internal product fields are not sent to the client", async () => {
  const sent = stringsSentToClient(await tree());
  expect(sent).toContain("Fibre guide");
  expect(sent).not.toContain("costCents");
  expect(sent).not.toContain("1234");
});

it("metadata: never indexed", async () => {
  const meta = await generateMetadata({ params: Promise.resolve({ subAccountId: SA, slug: "fibre-guide" }) });
  expect(meta.robots).toEqual({ index: false, follow: false });
  expect(meta.title).toContain("Fibre guide");
});
