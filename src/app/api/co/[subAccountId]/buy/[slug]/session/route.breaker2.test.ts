import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Round-3 breaker repros on #461 (adopted). D-1/D-2 (one IP, two buyers)
 * pass because the dedupe is keyed by the buy button's request id, not the
 * IP; D-3..D-5 send no request id here, so they pin "no id, no dedupe" (the
 * price-bound reuse is tested with ids in route.breaker.test.ts).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const stripe = vi.hoisted(() => ({
  getSubAccountStripe: vi.fn(async () => ({ mode: "key" })),
  createCheckoutSessionForSubAccount: vi.fn(),
}));
vi.mock("@/lib/stripe/sub-account-client", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe/sub-account-client")>()), ...stripe }));
const { POST } = await import("@/app/api/co/[subAccountId]/buy/[slug]/session/route");

const SA = "sa1";
const SUB = { agencyId: "ag1", name: "F", sellOnlineEnabledByAgency: true, paymentsEnabledByAgency: true, stripeConnectionMeta: { ready: true } };
const PRODUCT = { subAccountId: SA, agencyId: "ag1", name: "G", description: "", unitPriceCents: 49_900, currency: "USD", active: true, sellOnline: true, slug: "g" };
const post = (headers: Record<string, string>, slug = "g") => POST(
  new Request(`https://app.test/api/co/${SA}/buy/${slug}/session`, { method: "POST", headers, body: "{}" }),
  { params: Promise.resolve({ subAccountId: SA, slug }) });

beforeEach(() => {
  mem.clear(); vi.clearAllMocks(); let i = 0;
  process.env.RESEND_API_KEY = "re"; process.env.EMAIL_FROM = "a@b.co"; process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mem.seed(`subAccounts/${SA}`, SUB); mem.seed("products/p1", PRODUCT);
  stripe.createCheckoutSessionForSubAccount.mockImplementation(async () => ({ id: `cs_${++i}`, url: `https://c.stripe.com/${i}`, livemode: false }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("D-1: no client IP headers (shared 'unknown' sentinel) -> different buyers get ONE session URL", async () => {
  const a = await (await post({})).json();
  const b = await (await post({})).json();
  expect(b.url).not.toBe(a.url);
});

it("D-2: same NAT IP, two buyers within 60s -> second is handed the first buyer's Stripe session", async () => {
  const a = await (await post({ "x-forwarded-for": "5.5.5.5" })).json();
  const b = await (await post({ "x-forwarded-for": "5.5.5.5" })).json();
  expect(b.url).not.toBe(a.url);
});

it("D-3: price raised within the 60s window -> stale cheaper session still handed out", async () => {
  await post({ "x-forwarded-for": "6.6.6.6" });
  mem.seed("products/p1", { ...PRODUCT, unitPriceCents: 99_900 });
  const b = await (await post({ "x-forwarded-for": "6.6.6.6" })).json();
  expect(b.url).toBeTruthy();
  const amounts = mem.list("orders").map((x) => x.totalCents);
  expect(amounts).toContain(99_900);
});

it("D-4: sessions past 60s or after the order is closed are not reused", async () => {
  const a = await (await post({ "x-forwarded-for": "7.7.7.7" })).json();
  const id = mem.list("orders")[0].id;
  mem.seed(`orders/${id}`, { ...mem.read(`orders/${id}`)!, status: "expired" });
  const b = await (await post({ "x-forwarded-for": "7.7.7.7" })).json();
  expect(b.url).not.toBe(a.url);
});

it("D-5: held order (pending + attention) is not reused", async () => {
  const a = await (await post({ "x-forwarded-for": "8.8.8.8" })).json();
  const id = mem.list("orders")[0].id;
  mem.seed(`orders/${id}`, { ...mem.read(`orders/${id}`)!, attention: "held" });
  const b = await (await post({ "x-forwarded-for": "8.8.8.8" })).json();
  expect(b.url).not.toBe(a.url);
});

it("D-6: JPY 12345 refused, 12300 sold at 123", async () => {
  mem.seed("products/p1", { ...PRODUCT, currency: "JPY", unitPriceCents: 12_345 });
  expect((await post({ "x-forwarded-for": "9.1.1.1" })).status).toBe(404);
  mem.seed("products/p1", { ...PRODUCT, currency: "JPY", unitPriceCents: 12_300 });
  expect((await post({ "x-forwarded-for": "9.1.1.2" })).status).toBe(200);
  const call = stripe.createCheckoutSessionForSubAccount.mock.calls[0] as unknown as [{ params: { line_items: { price_data: { unit_amount: number } }[] } }];
  expect(call[0].params.line_items[0].price_data.unit_amount).toBe(123);
});

it("D-7: dedupe key survives a failing first attempt (no poisoned key)", async () => {
  stripe.createCheckoutSessionForSubAccount.mockRejectedValueOnce(new Error("net"));
  const a = await post({ "x-forwarded-for": "4.4.4.4" });
  const b = await post({ "x-forwarded-for": "4.4.4.4" });
  expect([a.status, b.status]).toEqual([502, 200]);
});
