import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Round-4 breaker repros on #461 (adopted). N1 was a regression (concurrent
 * deliveries created duplicate contacts), fixed by the contact-link claim.
 * N8 is ACCEPTED and pinned: an order fully refunded before its contact
 * linked never fires order.paid (documented; order.paid is at most once).
 */
import { flushAfterResponse } from "@/lib/server/after-response";
import { deliverTo, mem, seedConnection, seedOrder, SA, session } from "@/test/stripe-orders-harness";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
const fireWorkflowTrigger = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger }));
const emitWebhookEvent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent }));
const sendEmail = vi.hoisted(() => vi.fn(async (_m: { to: string }) => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...(await orig<typeof import("@/lib/comms/resend")>()), sendEmail }));
const cap = vi.hoisted(() => ({ failTimes: 0 }));
vi.mock("@/lib/comms/ai/capture", async (orig) => {
  const real = await orig<typeof import("@/lib/comms/ai/capture")>();
  return { ...real, reconcileContactFromCapture: async (i: Parameters<typeof real.reconcileContactFromCapture>[0]) => {
    if (cap.failTimes > 0) { cap.failTimes--; throw new Error("transient"); }
    return real.reconcileContactFromCapture(i);
  } };
});
const deliver = deliverTo((await import("@/app/api/webhooks/stripe/sa/[subAccountId]/route")).POST);
const order = (over: Record<string, unknown> = {}) =>
  seedOrder("o1", { source: "product_link", quoteId: null, currency: "usd", subtotalCents: 49_900, totalCents: 49_900,
    productLinkProductId: "p1",
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [], ...over });
const paid = (over: Record<string, unknown> = {}) =>
  session("cs_o1", { amount_total: 49_900, currency: "usd", customer_details: { email: "b@example.com", name: "Bea", phone: null }, ...over });
type Call = [{ type: string }];
const typed = (calls: unknown, type: string) => (calls as Call[]).filter(([c]) => c.type === type).length;
const orderPaidFires = () => typed(fireWorkflowTrigger.mock.calls, "order.paid") + typed(emitWebhookEvent.mock.calls, "order.paid");

beforeEach(() => {
  mem.clear(); vi.clearAllMocks(); cap.failTimes = 0;
  process.env.RESEND_API_KEY = "re"; process.env.EMAIL_FROM = "s@e.com";
  seedConnection(); mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture" });
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("N1: three concurrent deliveries -> ONE contact, one contact.created, one order.paid", async () => {
  order();
  const res = await Promise.all([deliver("checkout.session.completed", paid(), "e1"), deliver("checkout.session.completed", paid(), "e2"), deliver("checkout.session.async_payment_succeeded", paid(), "e3")]);
  await flushAfterResponse();
  expect(mem.list("contacts")).toHaveLength(1);
  expect(typed(emitWebhookEvent.mock.calls, "contact.created")).toBe(1);
  expect(typed(fireWorkflowTrigger.mock.calls, "contact.created")).toBe(1);
  // The deliveries that found the step claimed answered 5xx, for Stripe to retry.
  expect(res.filter((r) => r.status >= 500).length).toBe(2);
  expect(orderPaidFires()).toBe(2);
});

it("N1: a stale claim (its holder died) is taken over", async () => {
  order({ status: "paid", contactLinkClaimedAt: Date.now() - 61_000, contactLinkClaimToken: "dead" });
  expect((await deliver("checkout.session.completed", paid(), "e1")).status).toBe(200);
  expect(mem.read("orders/o1")!.contactId).toBe(mem.list("contacts")[0].id);
});

it("N1: a fresh claim held by another delivery answers 5xx and creates nothing", async () => {
  order({ status: "paid", contactLinkClaimedAt: Date.now() - 1_000, contactLinkClaimToken: "live" });
  expect((await deliver("checkout.session.completed", paid(), "e1")).status).toBeGreaterThanOrEqual(500);
  expect(mem.list("contacts")).toHaveLength(0);
});

it("N2: concurrent deliveries -> order.paid fires exactly once (workflow + webhook), one email", async () => {
  order();
  await Promise.all([deliver("checkout.session.completed", paid(), "e1"), deliver("checkout.session.completed", paid(), "e2"), deliver("checkout.session.completed", paid(), "e3")]);
  await flushAfterResponse();
  expect(typed(fireWorkflowTrigger.mock.calls, "order.paid")).toBe(1);
  expect(typed(emitWebhookEvent.mock.calls, "order.paid")).toBe(1);
  expect(sendEmail).toHaveBeenCalledTimes(1);
});

it("N3: contact fails twice then succeeds -> paid at once; order.paid fires once, only after link; email once", async () => {
  order(); cap.failTimes = 2;
  expect((await deliver("checkout.session.completed", paid(), "e1")).status).toBe(500);
  expect(mem.read("orders/o1")!.status).toBe("paid");
  expect(orderPaidFires()).toBe(0);
  expect((await deliver("checkout.session.completed", paid(), "e2")).status).toBe(500);
  expect((await deliver("checkout.session.completed", paid(), "e3")).status).toBe(200);
  await flushAfterResponse();
  expect(typed(fireWorkflowTrigger.mock.calls, "order.paid")).toBe(1);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(mem.read("orders/o1")!.contactId).toBeTruthy();
});

it("N4: completed vs expired race -> never expired-with-money-unflagged", async () => {
  order();
  const expired = { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" };
  await Promise.all([deliver("checkout.session.expired", expired, "e1"), deliver("checkout.session.completed", paid(), "e2")]);
  const o = mem.read("orders/o1")!;
  expect(o.status === "paid" || (o.status === "expired" && !!o.attention)).toBe(true);
});

it("N5: expired then paid: flagged; a later full refund of that payment is recorded on the order", async () => {
  order();
  await deliver("checkout.session.expired", { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" }, "e1");
  await deliver("checkout.session.completed", paid(), "e2");
  expect(mem.read("orders/o1")!.attention).toBeTruthy();
  await deliver("charge.refunded", { id: "ch1", payment_intent: "pi_cs_o1", amount_refunded: 49_900, currency: "usd" }, "e3");
  expect(mem.read("orders/o1")!.refundedCents).toBe(49_900);
});

it("N6: held order: replay, partial refund, replay again, async success -> still pending, no events, no email, no contact", async () => {
  order();
  await deliver("checkout.session.completed", paid({ amount_total: 60_000 }), "e1");
  await deliver("charge.refunded", { id: "ch1", payment_intent: "pi_cs_o1", amount_refunded: 10_100, currency: "usd" }, "e2");
  await deliver("checkout.session.completed", paid({ amount_total: 60_000 }), "e3");
  await deliver("checkout.session.async_payment_succeeded", paid({ amount_total: 60_000 }), "e4");
  await flushAfterResponse();
  const o = mem.read("orders/o1")!;
  expect(o.paidAt ?? null).toBeNull();
  expect(orderPaidFires()).toBe(0);
  expect(sendEmail).not.toHaveBeenCalled();
  expect(mem.list("contacts")).toHaveLength(0);
});

it("N7: held with MATCHING replay (same session re-sent with the right amount) -> still held", async () => {
  order();
  await deliver("checkout.session.completed", paid({ amount_total: 100 }), "e1");
  await deliver("checkout.session.completed", paid(), "e2");
  expect(mem.read("orders/o1")!.status).toBe("pending");
});

it("N8 (accepted): paid, then fully refunded BEFORE the contact linked -> order.paid never fires", async () => {
  order(); cap.failTimes = 1;
  await deliver("checkout.session.completed", paid(), "e1");
  await deliver("charge.refunded", { id: "ch1", payment_intent: "pi_cs_o1", amount_refunded: 49_900, currency: "usd" }, "e2");
  await deliver("checkout.session.completed", paid(), "e3");
  await flushAfterResponse();
  expect(orderPaidFires()).toBe(0);
});

it("closed + paid: the payment is recorded without changing the status; a replay isn't re-flagged", async () => {
  order({ status: "expired" });
  await deliver("checkout.session.completed", paid(), "e1");
  const first = mem.read("orders/o1")!;
  expect(first).toMatchObject({ status: "expired", stripePaymentIntentId: "pi_cs_o1", buyerEmail: "b@example.com", attentionOpen: true });
  mem.seed("orders/o1", { ...first, attention: null, attentionOpen: false });
  await deliver("checkout.session.completed", paid(), "e2");
  expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
  // Different money on an order that already records a payment is flagged.
  await deliver("checkout.session.completed", paid({ payment_intent: "pi_other" }), "e3");
  expect(mem.read("orders/o1")!.attention).toMatch(/already expired/);
});

it("N9: webhook-emit failure after the claim -> order.paid is never retried", async () => {
  order();
  emitWebhookEvent.mockRejectedValueOnce(new Error("subscriber down"));
  await deliver("checkout.session.completed", paid(), "e1");
  await flushAfterResponse();
  await deliver("checkout.session.completed", paid(), "e2");
  await flushAfterResponse();
  expect(typed(fireWorkflowTrigger.mock.calls, "order.paid")).toBe(1);
});
