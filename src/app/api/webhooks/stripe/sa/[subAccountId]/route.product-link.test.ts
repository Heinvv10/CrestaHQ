import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import { deliverTo, mem, seedConnection, seedOrder, SA, session } from "@/test/stripe-orders-harness";

/**
 * Express buy-link orders (source "product_link") through the real webhook
 * route and reconciler: payment marks the order paid and finds or creates the
 * buyer's contact from the email Stripe collected, once; a session that
 * collected a different amount than the order was opened for is flagged.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
const fireWorkflowTrigger = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));

const deliver = deliverTo((await import("./route")).POST);

const productLinkOrder = (over: Record<string, unknown> = {}) =>
  seedOrder("o1", {
    source: "product_link",
    quoteId: null,
    currency: "usd",
    subtotalCents: 49_900,
    totalCents: 49_900,
    productLinkProductId: "p1",
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

it("a session that collected another amount is flagged on the order", async () => {
  productLinkOrder();
  expect((await deliver("checkout.session.completed", paid({ amount_total: 100 }))).status).toBe(200);
  expect(mem.read("orders/o1")!.attention).toMatch(/differs from this order/);
});

it("a session in another currency is flagged on the order", async () => {
  productLinkOrder();
  expect((await deliver("checkout.session.completed", paid({ currency: "eur" }))).status).toBe(200);
  expect(mem.read("orders/o1")!.attention).toMatch(/differs from this order/);
});

it("Stripe's buyer name and email are capped before they are stored", async () => {
  productLinkOrder();
  const long = `${"a".repeat(300)}@example.com`;
  await deliver("checkout.session.completed", paid({ customer_details: { email: long, name: "N".repeat(500), phone: null } }));
  const order = mem.read("orders/o1")!;
  expect((order.buyerEmail as string).length).toBeLessThanOrEqual(254);
  expect((order.buyerName as string).length).toBeLessThanOrEqual(200);
});
