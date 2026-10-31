import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/** Round-4 breaker probes of the request-id dedupe on #461 (adopted; all held). */

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
let n = 0;
const U = (k: string) => `${k.padStart(8, "0").slice(0, 8)}-1111-4111-8111-111111111111`;
const post = (body: unknown, slug = "g", sa = SA) => POST(
  new Request(`https://app.test/api/co/${sa}/buy/${slug}/session`, { method: "POST", headers: { "x-forwarded-for": `9.9.${Math.floor(++n / 250)}.${n % 250}`, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  { params: Promise.resolve({ subAccountId: sa, slug }) });

beforeEach(() => {
  mem.clear(); vi.clearAllMocks(); let i = 0;
  process.env.RESEND_API_KEY = "re"; process.env.EMAIL_FROM = "a@b.co"; process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  mem.seed(`subAccounts/${SA}`, SUB); mem.seed("products/p1", PRODUCT);
  stripe.createCheckoutSessionForSubAccount.mockImplementation(async () => ({ id: `cs_${++i}`, url: `https://c.stripe.com/${i}`, livemode: false }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("Q1: two different ids never share a session", async () => {
  const a = await (await post({ requestId: U("aaaa") })).json();
  const b = await (await post({ requestId: U("bbbb") })).json();
  expect(a.url).not.toBe(b.url);
});
it("Q2: same id twice -> same session, one order", async () => {
  const a = await (await post({ requestId: U("aaaa") })).json();
  const b = await (await post({ requestId: U("AAAA") })).json();
  expect(b.url).toBe(a.url); expect(mem.list("orders")).toHaveLength(1);
});
it("Q3: same id on ANOTHER product / tenant is not shared", async () => {
  mem.seed("products/p2", { ...PRODUCT, slug: "h" });
  const a = await (await post({ requestId: U("aaaa") }, "g")).json();
  const b = await (await post({ requestId: U("aaaa") }, "h")).json();
  expect(b.url).not.toBe(a.url);
});
it("Q4: bad ids are rejected: number, null, object, long string, non-uuid", async () => {
  for (const id of [1, null, {}, "x".repeat(5000), "not-a-uuid", [U("aaaa")]]) {
    // A 5,000-character id is past the 4 KB body cap: 413, also a refusal.
    expect([400, 413], JSON.stringify(id).slice(0, 30)).toContain((await post({ requestId: id })).status);
  }
  expect(mem.list("orders")).toHaveLength(0);
});
it("Q5: body is array / string / invalid json / null -> no crash, no dedupe", async () => {
  for (const b of ["[]", "\"x\"", "{bad", "null", ""]) {
    const r = await post(b);
    expect([200, 400], b).toContain(r.status);
  }
});
it("Q6: __proto__ / extra keys ignored", async () => {
  const r = await post('{"__proto__":{"requestId":"x"},"unitPriceCents":1,"requestId":"' + U("cccc") + '"}');
  expect(r.status).toBe(200);
  expect(mem.list("orders")[0].totalCents).toBe(49_900);
});
it("Q7: id reused after price change -> new session at the new price", async () => {
  await post({ requestId: U("aaaa") });
  mem.seed("products/p1", { ...PRODUCT, unitPriceCents: 99_900 });
  await post({ requestId: U("aaaa") });
  expect(mem.list("orders").map((o) => o.totalCents).sort()).toEqual([49_900, 99_900]);
});
it("Q8: id reused after 30s -> new session", async () => {
  await post({ requestId: U("aaaa") });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  await post({ requestId: U("aaaa") });
  expect(mem.list("orders")).toHaveLength(2);
});
it("Q9: 10 concurrent same-id -> one order, one stripe call", async () => {
  const rs = await Promise.all(Array.from({ length: 10 }, () => post({ requestId: U("dddd") })));
  expect(new Set((await Promise.all(rs.map((r) => r.json()))).map((j) => j.url)).size).toBe(1);
  expect(stripe.createCheckoutSessionForSubAccount).toHaveBeenCalledTimes(1);
});
it("Q10: id reused after the order is PAID (webhook landed) -> a new session, not the paid one", async () => {
  const a = await (await post({ requestId: U("eeee") })).json();
  const o = mem.list("orders")[0];
  mem.seed(`orders/${o.id}`, { ...o, status: "paid" });
  const b = await (await post({ requestId: U("eeee") })).json();
  expect(b.url).not.toBe(a.url);
});
it("Q11: first attempt Stripe-fails, same id retried -> fresh attempt succeeds", async () => {
  stripe.createCheckoutSessionForSubAccount.mockRejectedValueOnce(new Error("net"));
  const a = await post({ requestId: U("ffff") });
  const b = await post({ requestId: U("ffff") });
  expect([a.status, b.status]).toEqual([502, 200]);
});
