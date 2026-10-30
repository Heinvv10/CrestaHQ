import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEY, SA, mem, seedAttempt, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * What a disconnect of Paystack costs the operator in emails when buyers
 * abandoned checkouts: the route's own sequence (list the open attempts,
 * sweep them with the outgoing key, flag what is still open), counted at the
 * mail transport. One email per attempt that may really hold a payment, none
 * for an expired or closed one, none on a repeat.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async (_m: { to: string; text: string }) => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...(await orig<typeof import("@/lib/comms/resend")>()), sendEmail }));

const { listOpenAttempts, sweepAttempts } = await import("./attempt-sweep");
const { flagStaleAttempts } = await import("@/lib/server/payment-attempts");
const { expireStalePaystackOrders } = await import("@/lib/server/paystack-order-expiry");

const HOUR = 60 * 60 * 1000;

function seedBuy(n: number, ageHours: number) {
  mem.seed(`orders/ord${n}`, {
    agencyId: "ag1",
    subAccountId: SA,
    source: "product_link",
    status: "pending",
    currency: "zar",
    totalCents: 49_900,
    stripeCheckoutSessionId: "",
    paystackReference: `po-ord${n}`,
    lineItems: [],
  });
  seedAttempt(`po-ord${n}`, { paymentLinkId: "", orderId: `ord${n}`, createdAt: new Date(Date.now() - ageHours * HOUR) });
}

/** The DELETE route's sequence for a workspace whose key is KEY. */
async function disconnect() {
  const toSweep = await listOpenAttempts(SA, KEY);
  await mem.db.doc(`subAccounts/${SA}/private/paystackConnection`).delete();
  await sweepAttempts(SA, KEY, toSweep);
  await flagStaleAttempts(SA, null);
}
const mails = () => sendEmail.mock.calls.map(([m]) => m);

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  seedSub();
  mem.seed(`subAccounts/${SA}/subAccountMembers/a1`, { role: "admin", status: "active", email: "admin@example.com" });
  stubPaystack((c) => verified({ reference: c.path.split("/").pop()!, status: "abandoned" }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("disconnecting Paystack with abandoned buys", () => {
  it("emails once per buy that is still young enough to hold a payment, and nothing for an old abandoned one", async () => {
    seedBuy(1, 1);
    seedBuy(2, 2);
    seedBuy(3, 30);
    await disconnect();

    expect(mails().map((m) => m.text.match(/Reference: (po-ord\d)/)?.[1]).sort()).toEqual(["po-ord1", "po-ord2"]);
    expect(mem.read("paymentAttempts/po-ord3")).toMatchObject({ state: "refused" });
    expect(mem.read("orders/ord3")).toMatchObject({ status: "expired" });
    expect(mem.read("orders/ord3")!.attention ?? null).toBeNull();
  });

  it("a repeat flags and emails nothing more", async () => {
    seedBuy(1, 1);
    await disconnect();
    await flagStaleAttempts(SA, null);
    await flagStaleAttempts(SA, null);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("buys the expiry sweep already closed send nothing at all", async () => {
    seedBuy(1, 30);
    seedBuy(2, 40);
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: KEY });
    await expireStalePaystackOrders(new Date());
    await disconnect();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.read("orders/ord1")).toMatchObject({ status: "expired" });
  });
});
