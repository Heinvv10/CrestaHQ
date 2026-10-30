import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Breaker repros from the #461 review (adopted), now fixed: a zero-decimal
 * price with cents is not sellable (REPRO 4), a double click opens one
 * session (REPRO 5), and a failed attach closes the order (REPRO 6).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const stripe = vi.hoisted(() => ({
  getSubAccountStripe: vi.fn(async () => ({ mode: "key" })),
  createCheckoutSessionForSubAccount: vi.fn(),
}));
vi.mock("@/lib/stripe/sub-account-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/sub-account-client")>()), ...stripe,
}));
const { POST } = await import("./route");

const SA = "sa1";
const SUB = { agencyId: "ag1", name: "F", sellOnlineEnabledByAgency: true, paymentsEnabledByAgency: true, stripeConnectionMeta: { ready: true } };
const PRODUCT = { subAccountId: SA, agencyId: "ag1", name: "G", description: "", unitPriceCents: 49_900, currency: "USD", active: true, sellOnline: true, slug: "g" };
let n = 0;
const post = (slug = "g", ip = `9.9.9.${++n}`) => POST(
  new Request(`https://app.test/api/co/${SA}/buy/${slug}/session`, { method: "POST", headers: { "x-forwarded-for": ip }, body: "{}" }),
  { params: Promise.resolve({ subAccountId: SA, slug }) });

beforeEach(() => {
  mem.clear(); vi.clearAllMocks(); let i = 0;
  process.env.RESEND_API_KEY = "re"; process.env.EMAIL_FROM = "a@b.co"; process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mem.seed(`subAccounts/${SA}`, SUB); mem.seed("products/p1", PRODUCT);
  stripe.createCheckoutSessionForSubAccount.mockImplementation(async () => ({ id: `cs_${++i}`, url: `https://c.stripe.com/${i}`, livemode: false }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("REPRO 4: a JPY price with sub-yen cents is not for sale: 404, no session, no order", async () => {
  mem.seed("products/p1", { ...PRODUCT, currency: "JPY", unitPriceCents: 12_345 });
  expect((await post()).status).toBe(404);
  expect(stripe.createCheckoutSessionForSubAccount).not.toHaveBeenCalled();
  expect(mem.list("orders")).toHaveLength(0);
});

it("REPRO 4: a whole-yen JPY price charges exactly what the order books", async () => {
  mem.seed("products/p1", { ...PRODUCT, currency: "JPY", unitPriceCents: 12_300 });
  expect((await post()).status).toBe(200);
  const call = stripe.createCheckoutSessionForSubAccount.mock.calls[0] as unknown as [{ params: { line_items: { price_data: { unit_amount: number } }[] } }];
  expect(call[0].params.line_items[0].price_data.unit_amount * 100).toBe(mem.list("orders")[0].totalCents);
});

it("REPRO 5: a double click opens one session and one pending order, both answers the same URL", async () => {
  const [a, b] = await Promise.all([post("g", "1.1.1.1"), post("g", "1.1.1.1")]);
  expect(mem.list("orders").filter((o) => o.status === "pending")).toHaveLength(1);
  expect(stripe.createCheckoutSessionForSubAccount).toHaveBeenCalledTimes(1);
  expect(await a.json()).toEqual(await b.json());
});

it("REPRO 5: a click after the minute, or once the order is no longer open, opens a new session", async () => {
  const first = await (await post("g", "2.2.2.2")).json();
  expect(await (await post("g", "2.2.2.2")).json()).toEqual(first);
  const [order] = mem.list("orders");
  mem.seed(`orders/${order.id}`, { ...order, status: "expired" });
  expect(await (await post("g", "2.2.2.2")).json()).not.toEqual(first);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
  const before = stripe.createCheckoutSessionForSubAccount.mock.calls.length;
  await post("g", "2.2.2.2");
  expect(stripe.createCheckoutSessionForSubAccount.mock.calls.length).toBe(before + 1);
});

it("REPRO 5: another buyer (IP) or another product is never deduped", async () => {
  mem.seed("products/p2", { ...PRODUCT, slug: "h" });
  await Promise.all([post("g", "3.3.3.3"), post("g", "4.4.4.4"), post("h", "3.3.3.3")]);
  expect(stripe.createCheckoutSessionForSubAccount).toHaveBeenCalledTimes(3);
});

it("REPRO 6: attach fails after the Stripe session is created → 500 and the order is failed", async () => {
  const real = mem.db.runTransaction.bind(mem.db);
  vi.spyOn(mem.db, "runTransaction").mockImplementationOnce(async () => {
    throw new Error("boom");
  }).mockImplementation(real);
  const res = await post();
  expect(res.status).toBe(500);
  expect(stripe.createCheckoutSessionForSubAccount).toHaveBeenCalledTimes(1);
  expect(mem.list("orders")[0].status).toBe("failed");
});
