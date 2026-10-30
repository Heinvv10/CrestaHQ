import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { flushAfterResponse } from "@/lib/server/after-response";
import { deliverTo, mem, seedConnection, seedOrder, SA, session } from "@/test/stripe-orders-harness";

/**
 * Breaker repros from the #461 review (adopted). REPRO 1 and 2 are fixed:
 * an underpaid session holds the order (never paid, no download), and a
 * transient contact failure answers 5xx so Stripe's redelivery links it.
 * REPRO 3 is ACCEPTED and pinned here: the contact match is email-first,
 * the same rule as forms, so a buyer who types an existing customer's email
 * is recorded against that customer.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/stripe-orders-harness")).adminMock());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail: vi.fn(async () => ({ id: "m1" })),
}));
const cap = vi.hoisted(() => ({ fail: true }));
vi.mock("@/lib/comms/ai/capture", async (orig) => {
  const real = await orig<typeof import("@/lib/comms/ai/capture")>();
  return {
    ...real,
    reconcileContactFromCapture: async (i: Parameters<typeof real.reconcileContactFromCapture>[0]) => {
      if (cap.fail) { cap.fail = false; throw new Error("firestore unavailable"); }
      return real.reconcileContactFromCapture(i);
    },
  };
});

const deliver = deliverTo((await import("./route")).POST);
const { default: ThanksPage } = await import("@/app/co/[subAccountId]/buy/[slug]/thanks/page");

const TOKEN = "A".repeat(43);
const DOWNLOAD = "https://files.example.com/guide.pdf";
const order = (over: Record<string, unknown> = {}) =>
  seedOrder("o1", {
    source: "product_link", quoteId: null, currency: "usd", subtotalCents: 49_900, totalCents: 49_900,
    productLinkProductId: "p1",
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get" } }],
    thanksTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    ...over,
  });
const paid = (over: Record<string, unknown> = {}) =>
  session("cs_o1", { amount_total: 49_900, currency: "usd", customer_details: { email: "b@example.com", name: "B", phone: null }, ...over });
const thanks = async () =>
  renderToStaticMarkup((await ThanksPage({
    params: Promise.resolve({ subAccountId: SA, slug: "x" }),
    searchParams: Promise.resolve({ order: "o1", t: TOKEN }),
  })) as ReactElement);

beforeEach(() => {
  mem.clear(); cap.fail = false;
  seedConnection();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("REPRO 1: an underpaid session holds the order: never paid, flagged, no download", async () => {
  order();
  expect((await deliver("checkout.session.completed", paid({ amount_total: 100 }))).status).toBe(200);
  const stored = mem.read("orders/o1")!;
  expect(stored).toMatchObject({ status: "pending", attentionOpen: true, stripePaymentIntentId: "pi_cs_o1" });
  expect(stored.attention).toMatch(/differs from this order/);
  const html = await thanks();
  expect(html).not.toContain(DOWNLOAD);
  expect(html).toContain("quick check");
});

it("REPRO 2: a transient contact failure answers 5xx (the order is already paid); Stripe's redelivery links the contact", async () => {
  order(); cap.fail = true;
  expect((await deliver("checkout.session.completed", paid())).status).toBeGreaterThanOrEqual(500);
  expect(mem.read("orders/o1")!.status).toBe("paid");
  expect((await deliver("checkout.session.completed", paid(), "evt_2")).status).toBe(200);
  await flushAfterResponse();
  expect(mem.read("orders/o1")).toMatchObject({ status: "paid", contactId: expect.any(String) });
  expect(mem.list("contacts")).toHaveLength(1);
});

it("REPRO 2: an order already paid with no contact is linked on the next delivery", async () => {
  order({ status: "paid", paidAt: new Date() });
  expect((await deliver("checkout.session.completed", paid())).status).toBe(200);
  expect(mem.read("orders/o1")!.contactId).toBe(mem.list("contacts")[0].id);
});

it("REPRO 3 (accepted): an existing customer's email links the order to that customer", async () => {
  mem.seed("contacts/victim", { subAccountId: SA, agencyId: "ag1", email: "victim@example.com", name: "Victim" });
  order();
  await deliver("checkout.session.completed", paid({ customer_details: { email: "victim@example.com", name: "Attacker", phone: null } }));
  expect(mem.read("orders/o1")!.contactId).toBe("victim");
});
