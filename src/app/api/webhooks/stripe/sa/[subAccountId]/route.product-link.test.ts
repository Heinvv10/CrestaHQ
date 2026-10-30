import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import { deliverTo, mem, seedConnection, seedOrder, SA, session } from "@/test/stripe-orders-harness";

/**
 * Express buy-link orders (source "product_link") through the real webhook
 * route and reconciler: payment marks the order paid and finds or creates the
 * buyer's contact from the email Stripe collected, once; a session that
 * collected a different amount than the order was opened for is held (never
 * paid) and flagged; a paid order's confirmation is emailed exactly once, and
 * never for a held one; an expired session closes a pending order.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
const fireWorkflowTrigger = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async (_m: { to: string; subject: string; text: string }) => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail,
}));

const deliver = deliverTo((await import("./route")).POST);
const { sendOrderConfirmation } = await import("@/lib/server/order-confirmation-service");
const DOWNLOAD = "https://files.example.com/guide.pdf";

const productLinkOrder = (over: Record<string, unknown> = {}) =>
  seedOrder("o1", {
    source: "product_link",
    quoteId: null,
    currency: "usd",
    subtotalCents: 49_900,
    totalCents: 49_900,
    productLinkProductId: "p1",
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get the guide" } }],
    ...over,
  });
const paid = (over: Record<string, unknown> = {}) =>
  session("cs_o1", {
    amount_total: 49_900,
    currency: "usd",
    customer_details: { email: "  Buyer@Example.com ", name: "Bea Buyer", phone: null },
    ...over,
  });

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  seedConnection();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("paid: the order is paid and linked to the buyer's contact, once across a replay", async () => {
  productLinkOrder();
  expect((await deliver("checkout.session.completed", paid())).status).toBe(200);
  expect((await deliver("checkout.session.completed", paid(), "evt_2")).status).toBe(200);
  await flushAfterResponse();

  const contacts = mem.list("contacts");
  expect(contacts).toHaveLength(1);
  expect(contacts[0]).toMatchObject({ email: "buyer@example.com", subAccountId: SA });
  const order = mem.read("orders/o1")!;
  expect(order).toMatchObject({ status: "paid", buyerEmail: "buyer@example.com", buyerName: "Bea Buyer", contactId: contacts[0].id });
  expect(order.attention ?? null).toBeNull();
  // The order's workflow trigger saw the contact (it fires after the link).
  const orderPaid = (fireWorkflowTrigger.mock.calls as unknown as [{ type: string; contactId: string }][])
    .map(([arg]) => arg)
    .filter((arg) => arg.type === "order.paid");
  expect(orderPaid).toEqual([expect.objectContaining({ contactId: contacts[0].id })]);
});

it("a session that collected another amount is held, flagged, and never confirmed", async () => {
  productLinkOrder();
  expect((await deliver("checkout.session.completed", paid({ amount_total: 100 }))).status).toBe(200);
  expect((await deliver("checkout.session.completed", paid({ amount_total: 100 }), "evt_2")).status).toBe(200);
  await flushAfterResponse();
  expect(mem.read("orders/o1")).toMatchObject({ status: "pending", attentionOpen: true });
  expect(mem.read("orders/o1")!.attention).toMatch(/differs from this order/);
  expect(sendEmail).not.toHaveBeenCalled();
  expect(fireWorkflowTrigger).not.toHaveBeenCalledWith(expect.objectContaining({ type: "order.paid" }));
});

it("a session in another currency is held and flagged", async () => {
  productLinkOrder();
  expect((await deliver("checkout.session.completed", paid({ currency: "eur" }))).status).toBe(200);
  expect(mem.read("orders/o1")).toMatchObject({ status: "pending" });
  expect(mem.read("orders/o1")!.attention).toMatch(/differs from this order/);
});

describe("order confirmation", () => {
  it("paid: one email with the item, the amount and the download link, across replays", async () => {
    productLinkOrder();
    await deliver("checkout.session.completed", paid());
    await deliver("checkout.session.completed", paid(), "evt_2");
    await flushAfterResponse();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("buyer@example.com");
    expect(mail.subject).toContain("Fibre guide");
    expect(mail.text).toContain("Fibre guide");
    expect(mail.text).toContain("$499.00 USD");
    expect(mail.text).toContain(DOWNLOAD);
    expect(mem.read("orders/o1")!.confirmationEmail).toMatchObject({ state: "sent" });
  });

  it("two concurrent claims send once", async () => {
    productLinkOrder({ status: "paid", buyerEmail: "buyer@example.com" });
    const sent = await Promise.all([sendOrderConfirmation("o1"), sendOrderConfirmation("o1")]);
    expect(sent.filter(Boolean)).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a flagged paid order, a pending one, or another source is never confirmed", async () => {
    for (const over of [
      { status: "paid", attention: "check", attentionOpen: true },
      { status: "paid", attention: "resolved note", attentionOpen: false },
      { status: "pending" },
      { status: "paid", source: "checkout_page" },
    ]) {
      productLinkOrder({ buyerEmail: "buyer@example.com", ...over });
      expect(await sendOrderConfirmation("o1")).toBe(false);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("email not configured: recorded as failed, nothing sent, never retried", async () => {
    delete process.env.RESEND_API_KEY;
    productLinkOrder({ status: "paid", buyerEmail: "buyer@example.com" });
    expect(await sendOrderConfirmation("o1")).toBe(false);
    process.env.RESEND_API_KEY = "re_test";
    expect(await sendOrderConfirmation("o1")).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.read("orders/o1")!.confirmationEmail).toMatchObject({ state: "failed" });
  });

  it("a provider failure is recorded, not retried", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    productLinkOrder({ status: "paid", buyerEmail: "buyer@example.com" });
    expect(await sendOrderConfirmation("o1")).toBe(false);
    expect(await sendOrderConfirmation("o1")).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mem.read("orders/o1")!.confirmationEmail).toMatchObject({ state: "failed" });
  });
});

describe("checkout.session.expired", () => {
  const expired = { id: "cs_o1", object: "checkout.session", status: "expired", payment_status: "unpaid" };

  it("closes a pending buy-link order", async () => {
    productLinkOrder();
    expect((await deliver("checkout.session.expired", expired)).status).toBe(200);
    expect(mem.read("orders/o1")!.status).toBe("expired");
  });

  it("leaves a paid order, and another source's pending order, alone", async () => {
    productLinkOrder({ status: "paid" });
    await deliver("checkout.session.expired", expired);
    expect(mem.read("orders/o1")!.status).toBe("paid");
    productLinkOrder({ source: "checkout_page" });
    await deliver("checkout.session.expired", expired);
    expect(mem.read("orders/o1")!.status).toBe("pending");
  });

  it("an expired order is never marked paid afterwards", async () => {
    productLinkOrder({ status: "expired" });
    await deliver("checkout.session.completed", paid());
    expect(mem.read("orders/o1")!.status).toBe("expired");
  });
});

it("Stripe's buyer name and email are capped before they are stored", async () => {
  productLinkOrder();
  const long = `${"a".repeat(300)}@example.com`;
  await deliver("checkout.session.completed", paid({ customer_details: { email: long, name: "N".repeat(500), phone: null } }));
  const order = mem.read("orders/o1")!;
  expect((order.buyerEmail as string).length).toBeLessThanOrEqual(254);
  expect((order.buyerName as string).length).toBeLessThanOrEqual(200);
});

describe("paid only from pending, only on a match", () => {
  it("a held order, later partly refunded, stays held through every paid event", async () => {
    productLinkOrder();
    await deliver("checkout.session.completed", paid({ amount_total: 60_000 }), "e1");
    await deliver("charge.refunded", { id: "ch1", object: "charge", payment_intent: "pi_cs_o1", amount_refunded: 10_100 }, "e2");
    for (const [type, id] of [["checkout.session.completed", "e3"], ["checkout.session.async_payment_succeeded", "e4"]]) {
      await deliver(type, paid(), id);
    }
    await flushAfterResponse();
    const o = mem.read("orders/o1")!;
    expect(o.status).toBe("partially_refunded");
    expect(o.heldAt).toBeTruthy();
    expect(fireWorkflowTrigger).not.toHaveBeenCalledWith(expect.objectContaining({ type: "order.paid" }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a held order is never paid, even by a later event that matches", async () => {
    productLinkOrder();
    await deliver("checkout.session.completed", paid({ amount_total: 100 }), "e1");
    await deliver("checkout.session.completed", paid(), "e2");
    expect(mem.read("orders/o1")).toMatchObject({ status: "pending" });
  });

  it("a paid-then-partly-refunded order is never moved back to paid by a replay", async () => {
    productLinkOrder({ status: "partially_refunded", refundedCents: 100, stripePaymentIntentId: "pi_cs_o1", buyerEmail: "buyer@example.com" });
    await deliver("checkout.session.completed", paid());
    expect(mem.read("orders/o1")!.status).toBe("partially_refunded");
  });

  it("a matching amount on a pending order pays it", async () => {
    productLinkOrder();
    await deliver("checkout.session.completed", paid());
    expect(mem.read("orders/o1")).toMatchObject({ status: "paid", stripePaymentIntentId: "pi_cs_o1" });
    expect(mem.read("orders/o1")!.heldAt ?? null).toBeNull();
  });
});

describe("money for a closed order is flagged, never dropped", () => {
  it.each(["expired", "failed"])("%s, then paid → flagged, not paid", async (status) => {
    productLinkOrder({ status });
    expect((await deliver("checkout.session.completed", paid())).status).toBe(200);
    expect(mem.read("orders/o1")).toMatchObject({ status, attentionOpen: true });
    expect(mem.read("orders/o1")!.attention).toMatch(new RegExp(`already ${status}`));
  });

  it("a fully refunded order's own payment replayed is not flagged", async () => {
    productLinkOrder({ status: "refunded", stripePaymentIntentId: "pi_cs_o1" });
    await deliver("checkout.session.completed", paid());
    expect(mem.read("orders/o1")!.attention ?? null).toBeNull();
  });

  it("an expiry never closes a held order", async () => {
    productLinkOrder();
    await deliver("checkout.session.completed", paid({ amount_total: 1 }));
    await deliver("checkout.session.expired", { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" }, "e2");
    expect(mem.read("orders/o1")!.status).toBe("pending");
  });

  it("an expiry never closes a held order whose flag write hasn't landed yet", async () => {
    productLinkOrder({ heldAt: new Date() });
    await deliver("checkout.session.expired", { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" }, "e2");
    expect(mem.read("orders/o1")!.status).toBe("pending");
  });

  it("an expiry never closes a pending order flagged for another reason", async () => {
    productLinkOrder({ attention: "check", attentionOpen: true });
    await deliver("checkout.session.expired", { id: "cs_o1", object: "checkout.session", payment_status: "unpaid" }, "e2");
    expect(mem.read("orders/o1")!.status).toBe("pending");
  });
});

it("the confirmation never echoes buyer-typed text (name, email) back", async () => {
  for (const buyerName of ["https://evil.example/pay Now", "Zoë O'Neil"]) {
    sendEmail.mockClear();
    productLinkOrder({ status: "paid", buyerEmail: "buyer@example.com", buyerName });
    await sendOrderConfirmation("o1");
    const { text, subject } = sendEmail.mock.calls[0][0];
    expect(text.startsWith("Hi,\n")).toBe(true);
    for (const typed of [buyerName, buyerName.split(" ")[0], "buyer@example.com"]) {
      expect(text + subject).not.toContain(typed);
    }
    expect(text).toContain("Fibre guide");
  }
});

describe("delivery (entitlements)", () => {
  beforeEach(() => {
    process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
    mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", communityEnabledByAgency: true });
    mem.seed(`subAccounts/${SA}/communityGroups/g1`, {
      subAccountId: SA, agencyId: "ag1", name: "Fibre Club", slug: "fibre-club", access: "free", status: "published", memberCount: 0,
    });
  });
  const communityOrder = () =>
    productLinkOrder({ deliveries: [{ productId: "p1", delivery: { type: "community", communityGroupId: "g1", courseId: null } }] });

  it("a paid order is granted once across a replay, after the confirmation", async () => {
    communityOrder();
    await deliver("checkout.session.completed", paid());
    await deliver("checkout.session.completed", paid(), "evt_2");
    await flushAfterResponse();

    expect(mem.list("entitlements")).toEqual([
      expect.objectContaining({ id: "o1_p1", orderId: "o1", subAccountId: SA, agencyId: "ag1", sends: 1 }),
    ]);
    expect(mem.list(`subAccounts/${SA}/communityGroups/g1/purchases`)).toHaveLength(1);
    expect(sendEmail.mock.calls.map(([m]) => m.subject)).toEqual([
      "[Test] Order confirmed: Fibre guide",
      "Your access to Fibre guide",
    ]);
  });

  it("a held order (other amount) is never granted", async () => {
    communityOrder();
    await deliver("checkout.session.completed", paid({ amount_total: 100 }));
    await flushAfterResponse();
    expect(mem.list("entitlements")).toHaveLength(0);
    expect(mem.list(`subAccounts/${SA}/members`)).toHaveLength(0);
  });

  it("a full refund revokes the entitlement; a partial one leaves it", async () => {
    communityOrder();
    await deliver("checkout.session.completed", paid());
    await flushAfterResponse();
    const charge = (refunded: number) => ({ id: "ch_1", object: "charge", payment_intent: "pi_cs_o1", amount_refunded: refunded, currency: "usd" });

    await deliver("charge.refunded", charge(10_000), "evt_r1");
    expect(mem.read("entitlements/o1_p1")).toMatchObject({ status: "active" });
    await deliver("charge.refunded", charge(49_900), "evt_r2");
    expect(mem.read("orders/o1")).toMatchObject({ status: "refunded" });
    expect(mem.read("entitlements/o1_p1")).toMatchObject({ status: "revoked" });
    expect(mem.list(`subAccounts/${SA}/communityGroups/g1/memberships`)).toHaveLength(1);
  });
});
