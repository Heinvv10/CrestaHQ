import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Round-3 breaker repros on #461 (adopted). R-B is adapted to the ruled
 * behaviour: paid comes first, and a contact failure answers 5xx so Stripe
 * redelivers; order.paid waits for the contact link and fires once.
 */
import { flushAfterResponse } from "@/lib/server/after-response";
import { deliverTo, mem, seedConnection, seedOrder, SA, session } from "@/test/stripe-orders-harness";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
const fireWorkflowTrigger = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async (_m: { to: string; subject: string; text: string }) => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...(await orig<typeof import("@/lib/comms/resend")>()), sendEmail }));
const cap = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/comms/ai/capture", async (orig) => {
  const real = await orig<typeof import("@/lib/comms/ai/capture")>();
  return { ...real, reconcileContactFromCapture: async (i: Parameters<typeof real.reconcileContactFromCapture>[0]) => {
    if (cap.fail) throw new Error("persistent contact failure");
    return real.reconcileContactFromCapture(i);
  } };
});
const deliver = deliverTo((await import("@/app/api/webhooks/stripe/sa/[subAccountId]/route")).POST);
const DOWNLOAD = "https://files.example.com/guide.pdf";
const order = (over: Record<string, unknown> = {}) =>
  seedOrder("o1", { source: "product_link", quoteId: null, currency: "usd", subtotalCents: 49_900, totalCents: 49_900,
    productLinkProductId: "p1",
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get" } }], ...over });
const paid = (over: Record<string, unknown> = {}) =>
  session("cs_o1", { amount_total: 49_900, currency: "usd", customer_details: { email: "b@example.com", name: "Bea", phone: null }, ...over });
const ev = (type: string, o: Record<string, unknown>, id: string) => deliver(type, o, id);
type Trigger = { type: string; contactId?: string };
const orderPaidCalls = () =>
  (fireWorkflowTrigger.mock.calls as unknown as [Trigger][]).map(([t]) => t).filter((t) => t.type === "order.paid");

beforeEach(() => {
  mem.clear(); vi.clearAllMocks(); cap.fail = false;
  process.env.RESEND_API_KEY = "re"; process.env.EMAIL_FROM = "s@e.com";
  seedConnection(); mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture" });
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("R-A: held order + partial refund (overpayment) + resent completed event -> order becomes PAID and order.paid fires", async () => {
  order();
  await ev("checkout.session.completed", paid({ amount_total: 60_000 }), "e1");
  expect(mem.read("orders/o1")!.status).toBe("pending");
  await ev("charge.refunded", { id: "ch1", payment_intent: "pi_cs_o1", amount_refunded: 10_100, currency: "usd" }, "e2");
  expect(mem.read("orders/o1")!.status).toBe("partially_refunded");
  await ev("checkout.session.completed", paid({ amount_total: 60_000 }), "e3");
  await flushAfterResponse();
  expect(mem.read("orders/o1")!.status).not.toBe("paid");
  expect(orderPaidCalls()).toHaveLength(0);
});

it("R-B: a persistent contact failure doesn't block paid; 5xx until a delivery links it, then order.paid fires once", async () => {
  order(); cap.fail = true;
  const r1 = await ev("checkout.session.completed", paid(), "e1");
  expect(mem.read("orders/o1")!.status).toBe("paid");
  const r2 = await ev("checkout.session.completed", paid(), "e2");
  expect([r1.status, r2.status].every((s) => s >= 500)).toBe(true);
  await flushAfterResponse();
  expect(orderPaidCalls()).toHaveLength(0);
  cap.fail = false;
  expect((await ev("checkout.session.completed", paid(), "e3")).status).toBe(200);
  expect((await ev("checkout.session.completed", paid(), "e4")).status).toBe(200);
  await flushAfterResponse();
  const contactId = mem.read("orders/o1")!.contactId;
  expect(contactId).toBe(mem.list("contacts")[0].id);
  const orderPaid = orderPaidCalls();
  expect(orderPaid).toHaveLength(1);
  expect(orderPaid[0].contactId).toBe(contactId);
});

it("R-C: expired THEN paid -> money silently ignored, no attention flag", async () => {
  order();
  await ev("checkout.session.expired", { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" }, "e1");
  expect(mem.read("orders/o1")!.status).toBe("expired");
  await ev("checkout.session.completed", paid(), "e2");
  expect(mem.read("orders/o1")!.attention).toBeTruthy();
});

it("R-D: paid THEN expired -> stays paid", async () => {
  order();
  await ev("checkout.session.completed", paid(), "e1");
  await ev("checkout.session.expired", { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" }, "e2");
  expect(mem.read("orders/o1")!.status).toBe("paid");
});

it("R-E: held order is never emailed, and an expiry event can't close/alter a held one's money record", async () => {
  order();
  await ev("checkout.session.completed", paid({ amount_total: 100 }), "e1");
  await flushAfterResponse();
  expect(sendEmail).not.toHaveBeenCalled();
  await ev("checkout.session.expired", { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" }, "e2");
  expect(mem.read("orders/o1")!.status).toBe("pending"); // money taken: must not read 'expired'
});

it("R-F: concurrent deliveries -> exactly one confirmation email", async () => {
  order();
  await Promise.all([ev("checkout.session.completed", paid(), "e1"), ev("checkout.session.completed", paid(), "e2"), ev("checkout.session.async_payment_succeeded", paid(), "e3")]);
  await flushAfterResponse();
  expect(sendEmail).toHaveBeenCalledTimes(1);
});

it("R-G: buyer-typed name lands verbatim in a mail sent from the tenant to an arbitrary address", async () => {
  order();
  await ev("checkout.session.completed", paid({ customer_details: { email: "victim@example.com", name: "https://evil.example/pay-now", phone: null } }), "e1");
  await flushAfterResponse();
  const m = sendEmail.mock.calls[0]?.[0];
  expect(m?.text ?? "").not.toContain("evil.example");
});

it("R-H: price/currency edge: JPY order 12300 cents, Stripe 123 -> not held", async () => {
  order({ currency: "jpy", totalCents: 12_300, subtotalCents: 12_300 });
  await ev("checkout.session.completed", paid({ amount_total: 123, currency: "jpy" }), "e1");
  expect(mem.read("orders/o1")!.status).toBe("paid");
});

it("R-I: replayed mismatch event after operator resolves flag -> still pending, flag not reopened", async () => {
  order();
  await ev("checkout.session.completed", paid({ amount_total: 100 }), "e1");
  mem.seed("orders/o1", { ...mem.read("orders/o1")!, attentionOpen: false, attentionResolvedAt: new Date() });
  await ev("checkout.session.completed", paid({ amount_total: 100 }), "e2");
  const o = mem.read("orders/o1")!;
  expect(o.status).toBe("pending");
  expect(o.attentionOpen).toBe(false);
});
