import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Breaker repros from the #461 review (adopted), now fixed: a zero-decimal
 * price with cents is not sellable (REPRO 4), a double click (one request
 * id) opens one session (REPRO 5; round 3 moved the key from the IP to the
 * buy button's request id and binds reuse to the price), and a failed attach
 * closes the order (REPRO 6).
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

const RID = "3f2b8c1e-7a4d-4e9b-9c2a-1d5e6f7a8b9c";
const RID2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
let m = 0;
const postId = (requestId: unknown, ip = `7.7.${++m % 250}.1`, slug = "g") => POST(
  new Request(`https://app.test/api/co/${SA}/buy/${slug}/session`, {
    method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify({ requestId }) }),
  { params: Promise.resolve({ subAccountId: SA, slug }) });

it("REPRO 5: a double click (same request id) opens one session and one pending order, both answers the same URL", async () => {
  const [a, b] = await Promise.all([postId(RID), postId(RID)]);
  expect(mem.list("orders").filter((o) => o.status === "pending")).toHaveLength(1);
  expect(stripe.createCheckoutSessionForSubAccount).toHaveBeenCalledTimes(1);
  expect(await a.json()).toEqual(await b.json());
});

it("REPRO 5: past 30 s, or once the order is no longer open, the same id opens a new session", async () => {
  const first = await (await postId(RID)).json();
  expect(await (await postId(RID)).json()).toEqual(first);
  const [order] = mem.list("orders");
  mem.seed(`orders/${order.id}`, { ...order, status: "expired" });
  const second = await (await postId(RID)).json();
  expect(second).not.toEqual(first);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  expect(await (await postId(RID)).json()).not.toEqual(second);
});

it("REPRO 5: two request ids never share a session, even from one IP; no id means no dedupe", async () => {
  await Promise.all([postId(RID, "5.5.5.5"), postId(RID2, "5.5.5.5"), postId(undefined, "5.5.5.5"), postId(undefined, "5.5.5.5")]);
  expect(stripe.createCheckoutSessionForSubAccount).toHaveBeenCalledTimes(4);
});

it("REPRO 5: a double click after a stale entry for that id still opens one session", async () => {
  const id = "0d6c1b2a-3e4f-4a5b-9c6d-7e8f9a0b1c2d";
  await postId(id);
  const [order] = mem.list("orders");
  mem.seed(`orders/${order.id}`, { ...order, status: "expired" });
  const before = stripe.createCheckoutSessionForSubAccount.mock.calls.length;
  const [a, b] = await Promise.all([postId(id), postId(id)]);
  expect(stripe.createCheckoutSessionForSubAccount.mock.calls.length).toBe(before + 1);
  expect(await a.json()).toEqual(await b.json());
});

it("REPRO 5: the same request id for another product is never deduped", async () => {
  mem.seed("products/p2", { ...PRODUCT, slug: "h" });
  await Promise.all([postId(RID, "6.6.6.6", "g"), postId(RID, "6.6.6.6", "h")]);
  expect(stripe.createCheckoutSessionForSubAccount).toHaveBeenCalledTimes(2);
});

it("a request id that isn't a UUID → 400, nothing opened", async () => {
  for (const bad of ["x", 42, "3f2b8c1e-7a4d-4e9b-9c2a-1d5e6f7a8b9c-extra", { id: RID }]) {
    expect((await postId(bad)).status).toBe(400);
  }
  expect(stripe.createCheckoutSessionForSubAccount).not.toHaveBeenCalled();
  expect(mem.list("orders")).toHaveLength(0);
});

it("REPRO 3 (round 3): a price or currency change within the window opens a new session at the new price", async () => {
  const first = await (await postId(RID)).json();
  mem.seed("products/p1", { ...PRODUCT, unitPriceCents: 99_900 });
  const second = await (await postId(RID)).json();
  expect(second).not.toEqual(first);
  mem.seed("products/p1", { ...PRODUCT, unitPriceCents: 99_900, currency: "EUR" });
  expect(await (await postId(RID)).json()).not.toEqual(second);
  expect(mem.list("orders").map((o) => `${o.totalCents}${o.currency}`).sort()).toEqual(["49900usd", "99900eur", "99900usd"]);
});

it("a failed first attempt doesn't poison the key: the same id retries", async () => {
  stripe.createCheckoutSessionForSubAccount.mockRejectedValueOnce(new Error("net"));
  expect((await postId(RID)).status).toBeGreaterThanOrEqual(500);
  expect((await postId(RID)).status).toBe(200);
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
