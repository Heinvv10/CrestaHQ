import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";

import {
  KEY,
  OTHER_KEY,
  OTHER_SA,
  SA,
  mem,
  refused,
  seedAttempt,
  seedSub,
  stubPaystack,
  verified,
  type PaystackCall,
} from "@/test/paystack-links-harness";

/**
 * The lifetime of unpaid Paystack buy-page orders, through the real sweep,
 * reconciler and attempt flagging over an in-memory Firestore. Only Paystack's
 * HTTP API and the order fan-out are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...(await orig<typeof import("@/lib/comms/resend")>()), sendEmail }));

const { expireStalePaystackOrders, EXPIRY_BATCH, PAYSTACK_ORDER_LIFETIME_MS } = await import("./paystack-order-expiry");
const { flagStaleAttempts } = await import("@/lib/server/payment-attempts");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-30T12:00:00Z");
const OLD = new Date(NOW.getTime() - 25 * HOUR);

function seedBuy(
  n: number,
  createdAt: Date = OLD,
  orderOver: Record<string, unknown> = {},
  tenant: { sa: string; key: string } = { sa: SA, key: KEY },
) {
  const id = `ord${n}`;
  mem.seed(`orders/${id}`, {
    agencyId: "ag1",
    subAccountId: tenant.sa,
    contactId: null,
    source: "product_link",
    status: "pending",
    currency: "zar",
    totalCents: 49_900,
    subtotalCents: 49_900,
    refundedCents: 0,
    stripeCheckoutSessionId: "",
    paystackReference: `po-${id}`,
    buyerEmail: "buyer@example.com",
    lineItems: [{ productId: "p1", name: "Fibre guide", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    ...orderOver,
  });
  seedAttempt(`po-${id}`, {
    paymentLinkId: "",
    orderId: id,
    amountCents: 49_900,
    createdAt,
    subAccountId: tenant.sa,
    secretKey: tenant.key,
  });
  return `po-${id}`;
}
const order = (n: number) => mem.read(`orders/ord${n}`)!;
const attempt = (n: number) => mem.read(`paymentAttempts/po-ord${n}`)!;

let verifyAnswer: (reference: string, auth?: string | null) => ReturnType<typeof verified> | "network-error" | { status: number; body: unknown };
let calls: PaystackCall[];

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  seedSub();
  verifyAnswer = (reference) => verified({ reference, status: "abandoned", amount: 49_900 });
  calls = stubPaystack((c) => verifyAnswer(c.path.split("/").pop()!, c.auth));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("an abandoned buy", () => {
  it("expires after 24 hours: the order is expired, the attempt refused", async () => {
    seedBuy(1);
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, expired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(attempt(1)).toMatchObject({ state: "refused" });
    expect(calls).toEqual([expect.objectContaining({ path: "/transaction/verify/po-ord1", auth: `Bearer ${KEY}` })]);
  });

  it.each([
    ["failed", () => verified({ reference: "po-ord1", status: "failed" })],
    ["reversed", () => verified({ reference: "po-ord1", status: "reversed" })],
    ["unknown to Paystack", () => refused(404, "Transaction reference not found")],
  ])("%s also expires it", async (_name, answer) => {
    seedBuy(1);
    verifyAnswer = answer;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ expired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
  });

  it("younger than 24 hours is not even asked about", async () => {
    seedBuy(1, new Date(NOW.getTime() - (PAYSTACK_ORDER_LIFETIME_MS - HOUR)));
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 0, expired: 0 });
    expect(order(1)).toMatchObject({ status: "pending" });
    expect(calls).toHaveLength(0);
  });

  it("still in progress, or Paystack unreachable: left open for the next run", async () => {
    seedBuy(1);
    verifyAnswer = (reference) => verified({ reference, status: "ongoing" });
    await expireStalePaystackOrders(NOW);
    verifyAnswer = () => "network-error";
    await expect(expireStalePaystackOrders(NOW)).resolves.toMatchObject({ checked: 1, errors: 1 });
    expect(order(1)).toMatchObject({ status: "pending" });
    expect(attempt(1)).toMatchObject({ state: "open" });
  });

  it("a flagged or held order is never expired by the sweep", async () => {
    seedBuy(1, OLD, { attention: "Paid, check this", attentionOpen: true });
    await expireStalePaystackOrders(NOW);
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
  });

  it("is a no-op the second time", async () => {
    seedBuy(1);
    await expireStalePaystackOrders(NOW);
    calls.length = 0;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("a stuck attempt", () => {
  const ongoing = (reference: string) => verified({ reference, status: "ongoing", amount: 49_900 });

  it("Paystack still calls it ongoing after 7 days: closed like an abandoned one", async () => {
    seedBuy(1, new Date(NOW.getTime() - 8 * DAY));
    verifyAnswer = ongoing;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, expired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(attempt(1)).toMatchObject({ state: "refused" });
  });

  it("under 7 days it waits for the next run", async () => {
    seedBuy(1, new Date(NOW.getTime() - 6 * DAY));
    verifyAnswer = ongoing;
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, expired: 0 });
    expect(order(1)).toMatchObject({ status: "pending" });
    expect(attempt(1)).toMatchObject({ state: "open" });
  });

  it("30 stuck attempts no longer starve a newer abandoned one", async () => {
    for (let i = 1; i <= 30; i += 1) seedBuy(i, new Date(NOW.getTime() - 8 * DAY - (100 - i) * 1000));
    seedBuy(31, OLD);
    verifyAnswer = (reference) =>
      reference === "po-ord31" ? verified({ reference, status: "abandoned" }) : ongoing(reference);
    await expireStalePaystackOrders(NOW);
    expect(order(31)).toMatchObject({ status: "pending" });
    await expireStalePaystackOrders(NOW);
    expect(order(31)).toMatchObject({ status: "expired" });
    for (let i = 1; i <= 30; i += 1) expect(attempt(i)).toMatchObject({ state: "refused" });
  });
});

/** Pin when attempt `n` was flagged (the real flagging stamps the wall clock). */
function flaggedAt(n: number, at: Date) {
  mem.seed(`paymentAttempts/po-ord${n}`, { ...attempt(n), flaggedAt: at });
}

describe("an attempt whose key is no longer the workspace's", () => {
  /** 73 h after the default buy was opened (OLD = 25 h before NOW). */
  const LATE = new Date(NOW.getTime() + 48 * HOUR);
  const closedWithoutAsking = () => {
    expect(calls).toHaveLength(0);
    expect(attempt(1)).toMatchObject({ state: "refused" });
  };

  it("open and past 72 h after a key change: the order is expired and the attempt closed, Paystack never asked", async () => {
    seedBuy(1);
    seedSub(SA, OTHER_KEY);
    expect(await expireStalePaystackOrders(LATE)).toMatchObject({ checked: 0, expired: 1, retired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
    closedWithoutAsking();
    expect(attempt(1).reason).toMatch(/no longer connected/);
  });

  it("also after a disconnect", async () => {
    seedBuy(1);
    await mem.db.doc(`subAccounts/${SA}/private/paystackConnection`).delete();
    expect(await expireStalePaystackOrders(LATE)).toMatchObject({ expired: 1, retired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
    closedWithoutAsking();
  });

  it("the boundary is 72 h, not 24: Paystack retries a webhook for about that long", async () => {
    seedBuy(1, new Date(NOW.getTime() - 2 * HOUR));
    seedSub(SA, OTHER_KEY);
    const at = (hoursAfterOpen: number) => new Date(NOW.getTime() - 2 * HOUR + hoursAfterOpen * HOUR);
    expect(await expireStalePaystackOrders(at(25))).toMatchObject({ expired: 0, retired: 0 });
    expect(await expireStalePaystackOrders(at(71))).toMatchObject({ expired: 0, retired: 0 });
    // Not retirable yet: flagged on sight (the connection change should have), out of the open read.
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
    expect(await expireStalePaystackOrders(at(72))).toMatchObject({ expired: 1, retired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
  });

  it("flagged by the key change and past 72 h: expired too, with the order's flag kept", async () => {
    seedBuy(1, new Date(NOW.getTime() - 2 * HOUR));
    seedSub(SA, OTHER_KEY);
    await flagStaleAttempts(SA, paystackKeyFingerprint(OTHER_KEY));
    flaggedAt(1, new Date(NOW.getTime() - 2 * HOUR));
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(order(1)).toMatchObject({ attentionOpen: true });
    const flag = order(1).attention;

    expect(await expireStalePaystackOrders(new Date(NOW.getTime() + 68 * HOUR))).toMatchObject({ retired: 0 });
    expect(order(1)).toMatchObject({ status: "pending" });

    expect(await expireStalePaystackOrders(new Date(NOW.getTime() + 71 * HOUR))).toMatchObject({ expired: 1, retired: 1 });
    expect(order(1)).toMatchObject({ status: "expired", attentionOpen: true, attention: flag });
    closedWithoutAsking();
    expect(attempt(1).reason).toContain("Closed after 72 h");
    // The flagged note is kept on the attempt too.
    expect(attempt(1).reason).toContain(String(flag));
  });

  it("a late payment on the expired order is still flagged for a refund", async () => {
    seedBuy(1, new Date(NOW.getTime() - 2 * HOUR));
    seedSub(SA, OTHER_KEY);
    await flagStaleAttempts(SA, paystackKeyFingerprint(OTHER_KEY));
    flaggedAt(1, new Date(NOW.getTime() - 2 * HOUR));
    await expireStalePaystackOrders(new Date(NOW.getTime() + 71 * HOUR));
    seedSub(SA, KEY);
    const { reconcilePaystackCharge } = await import("@/lib/paystack/payment-link-reconciler");
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 49_900 });
    await reconcilePaystackCharge({ subAccountId: SA, secretKey: KEY, reference: "po-ord1" });
    expect(order(1)).toMatchObject({ status: "expired", attentionOpen: true });
    expect(order(1).attention).toMatch(/already expired/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a PAID order with a leftover open old-key attempt: the order is untouched, only the attempt is closed", async () => {
    seedBuy(1, OLD, { status: "paid", paidAt: new Date() });
    seedSub(SA, OTHER_KEY);
    expect(await expireStalePaystackOrders(LATE)).toMatchObject({ expired: 0, retired: 1 });
    expect(order(1)).toMatchObject({ status: "paid" });
    expect(attempt(1)).toMatchObject({ state: "refused" });
    // Out of the read window for good.
    expect(await expireStalePaystackOrders(LATE)).toMatchObject({ retired: 0 });
  });

  it("a held order: untouched (still held, still flagged); its old-key attempt is closed", async () => {
    seedBuy(1, OLD, { heldAt: new Date(), attention: "Held", attentionOpen: true });
    mem.seed("paymentAttempts/po-ord1", { ...attempt(1), state: "flagged", reason: "Held" });
    seedSub(SA, OTHER_KEY);
    const before = JSON.stringify(order(1));
    expect(await expireStalePaystackOrders(LATE)).toMatchObject({ expired: 0, retired: 1 });
    expect(JSON.stringify(order(1))).toBe(before);
    expect(attempt(1)).toMatchObject({ state: "refused" });
  });

  it("a failed order with a flagged old-key attempt: the order keeps its late-payment flag, the attempt is closed", async () => {
    seedBuy(1, OLD, { status: "failed", attention: "Paid, but failed", attentionOpen: true });
    mem.seed("paymentAttempts/po-ord1", { ...attempt(1), state: "flagged", reason: "Paid, but failed" });
    seedSub(SA, OTHER_KEY);
    const before = JSON.stringify(order(1));
    expect(await expireStalePaystackOrders(LATE)).toMatchObject({ expired: 0, retired: 1 });
    expect(JSON.stringify(order(1))).toBe(before);
    expect(attempt(1)).toMatchObject({ state: "refused" });
  });

  it("a key change near hour 71 still gives the operator a day: flagged at 71 h, nothing retired at 73 h, retired at 96 h", async () => {
    const openedAt = new Date(NOW.getTime() - 71 * HOUR);
    seedBuy(1, openedAt);
    seedSub(SA, OTHER_KEY);
    await flagStaleAttempts(SA, paystackKeyFingerprint(OTHER_KEY));
    flaggedAt(1, NOW);
    const at = (hoursAfterOpen: number) => new Date(openedAt.getTime() + hoursAfterOpen * HOUR);

    expect(await expireStalePaystackOrders(at(73))).toMatchObject({ expired: 0, retired: 0 });
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(await expireStalePaystackOrders(at(94))).toMatchObject({ retired: 0 });
    expect(await expireStalePaystackOrders(at(96))).toMatchObject({ expired: 1, retired: 1 });
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(attempt(1)).toMatchObject({ state: "refused" });
  });

  it("flagging stamps flaggedAt (and only the first flag does)", async () => {
    seedBuy(1, new Date(NOW.getTime() - 2 * HOUR));
    seedSub(SA, OTHER_KEY);
    await flagStaleAttempts(SA, paystackKeyFingerprint(OTHER_KEY));
    const first = attempt(1).flaggedAt as Date;
    expect(first).toBeInstanceOf(Date);
    flaggedAt(1, new Date(NOW.getTime() - HOUR));
    await flagStaleAttempts(SA, paystackKeyFingerprint(OTHER_KEY));
    expect((attempt(1).flaggedAt as Date).getTime()).toBe(NOW.getTime() - HOUR);
  });

  it("an attempt flagged before flaggedAt existed falls back to its age alone", async () => {
    seedBuy(1, OLD);
    seedSub(SA, OTHER_KEY);
    mem.seed("paymentAttempts/po-ord1", { ...attempt(1), state: "flagged", reason: "Old flag" });
    expect(await expireStalePaystackOrders(LATE)).toMatchObject({ expired: 1, retired: 1 });
  });
});

describe("a flagged buy whose key is the workspace's again", () => {
  /** Opened 2 h before NOW, flagged by a disconnect, same key reconnected: 73 h old at this time. */
  const AT = new Date(NOW.getTime() + 71 * HOUR);
  async function disconnectAndReconnectSameKey() {
    seedBuy(1, new Date(NOW.getTime() - 2 * HOUR));
    await mem.db.doc(`subAccounts/${SA}/private/paystackConnection`).delete();
    await flagStaleAttempts(SA, null);
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
    seedSub(SA, KEY);
  }

  it.each(["abandoned", "failed"])("%s at 73 h: the order expires (its flag kept) and the attempt closes", async (status) => {
    await disconnectAndReconnectSameKey();
    const flag = order(1).attention;
    verifyAnswer = (reference) => verified({ reference, status });
    expect(await expireStalePaystackOrders(AT)).toMatchObject({ checked: 1, expired: 1 });
    expect(order(1)).toMatchObject({ status: "expired", attentionOpen: true, attention: flag });
    expect(attempt(1)).toMatchObject({ state: "refused" });
    expect(attempt(1).reason).toContain(`Paystack: ${status}`);
  });

  it("not_found at 73 h closes it too", async () => {
    await disconnectAndReconnectSameKey();
    verifyAnswer = () => refused(404, "Transaction reference not found");
    await expireStalePaystackOrders(AT);
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(attempt(1)).toMatchObject({ state: "refused" });
  });

  it("success at 73 h reconciles it: paid, the flag lifted, one email", async () => {
    await disconnectAndReconnectSameKey();
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 49_900 });
    expect(await expireStalePaystackOrders(AT)).toMatchObject({ checked: 1, reconciled: 1 });
    await flushAfterResponse();
    expect(order(1)).toMatchObject({ status: "paid", attentionOpen: false, attention: null });
    expect(attempt(1)).toMatchObject({ state: "settled" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("under 72 h it is not asked (and not even read)", async () => {
    await disconnectAndReconnectSameKey();
    expect(await expireStalePaystackOrders(new Date(NOW.getTime() + 68 * HOUR))).toMatchObject({ checked: 0 });
    expect(attempt(1)).toMatchObject({ state: "flagged" });
  });

  it("still ongoing: left flagged, and the ask counts against the workspace cap like any other", async () => {
    for (let i = 1; i <= 5; i += 1) {
      seedBuy(i, new Date(NOW.getTime() - 2 * HOUR - i * 1000));
    }
    await flagStaleAttempts(SA, null);
    seedSub(SA, KEY);
    verifyAnswer = (reference) => verified({ reference, status: "ongoing" });
    expect(await expireStalePaystackOrders(AT)).toMatchObject({ checked: 3, skipped: 2 });
    expect(attempt(1)).toMatchObject({ state: "flagged" });
  });

  it("a held order's flagged attempt is not asked about (the money is already accounted for)", async () => {
    seedBuy(1, OLD, { heldAt: new Date(), attention: "Held", attentionOpen: true });
    mem.seed("paymentAttempts/po-ord1", { ...attempt(1), state: "flagged", reason: "Held" });
    expect(await expireStalePaystackOrders(new Date(NOW.getTime() + 48 * HOUR))).toMatchObject({ checked: 0, expired: 0 });
    expect(calls).toHaveLength(0);
    expect(order(1)).toMatchObject({ status: "pending" });
  });
});

describe("a rejected key reaches the operator", () => {
  const sentSubjects = () => (sendEmail.mock.calls as unknown as [{ subject: string }][]).map(([m]) => m.subject);

  beforeEach(() => {
    mem.seed(`subAccounts/${SA}/subAccountMembers/a1`, { role: "admin", status: "active", email: "admin@example.com" });
    verifyAnswer = () => refused(401, "Invalid key");
  });

  it("emails the workspace's admins once for the key, not once per buy or per run", async () => {
    seedBuy(1);
    seedBuy(2);
    seedBuy(3);
    await expireStalePaystackOrders(NOW);
    await expireStalePaystackOrders(NOW);
    await expireStalePaystackOrders(NOW);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [mail] = sendEmail.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }];
    expect(mail.to).toBe("admin@example.com");
    expect(mail.subject).toContain("Paystack rejected your key");
    expect(mail.text).toContain("Reconnect Paystack under Settings → Payments");
    expect(mail.text).not.toContain("Amount");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[paystack/key-rejected]"));
  });

  it("a different key later rejected is a new flag", async () => {
    seedBuy(1);
    await expireStalePaystackOrders(NOW);
    seedSub(SA, OTHER_KEY);
    seedBuy(2, OLD, {}, { sa: SA, key: OTHER_KEY });
    mem.seed("paymentAttempts/po-ord1", { ...attempt(1), state: "refused" });
    await expireStalePaystackOrders(NOW);
    expect(sentSubjects()).toHaveLength(2);
  });

  it("nothing is sent for a workspace whose key is fine", async () => {
    seedBuy(1);
    verifyAnswer = (reference) => verified({ reference, status: "abandoned" });
    await expireStalePaystackOrders(NOW);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("a pile of buys on a replaced key cannot push another workspace out", () => {
  const B = { sa: OTHER_SA, key: OTHER_KEY };

  const pile = (n: number, sa: string) => {
    // Opened 1 h before NOW, so 31 h old at NOW + 30 h; the other workspace's buy is the newest of all.
    for (let i = 1; i <= n; i += 1) seedBuy(i, new Date(NOW.getTime() - HOUR - (2000 - i) * 1000), {}, { sa, key: KEY });
  };
  const AT = new Date(NOW.getTime() + 30 * HOUR);

  beforeEach(() => mem.seed(`subAccounts/${SA}/subAccountMembers/a1`, { role: "admin", status: "active", email: "admin@example.com" }));

  it("1200 buys, the key changed and flagged, the sweep at +30 h: the other workspace's abandoned buy still expires on that run", async () => {
    seedSub(OTHER_SA, OTHER_KEY);
    pile(1200, SA);
    seedBuy(5000, new Date(NOW.getTime() - HOUR), {}, B);
    seedSub(SA, "sk_test_k9");
    await flagStaleAttempts(SA, paystackKeyFingerprint("sk_test_k9"));
    expect(attempt(1)).toMatchObject({ state: "flagged" });

    const summary = await expireStalePaystackOrders(AT);
    expect(order(5000)).toMatchObject({ status: "expired" });
    expect(summary).toMatchObject({ expired: 1, retired: 0 });
    expect(order(1)).toMatchObject({ status: "pending" });
  }, 120_000);

  it("1200 buys on a replaced key that were NEVER flagged (the change missed them): still expires the other workspace's buy on the first run", async () => {
    seedSub(OTHER_SA, OTHER_KEY);
    pile(1200, SA);
    seedBuy(5000, new Date(NOW.getTime() - HOUR), {}, B);
    seedSub(SA, "sk_test_k9");
    expect(attempt(1)).toMatchObject({ state: "open" });

    const summary = await expireStalePaystackOrders(AT);
    expect(order(5000)).toMatchObject({ status: "expired" });
    expect(summary).toMatchObject({ retired: 0 });
    // The whole pile left the open read in one go.
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(attempt(1200)).toMatchObject({ state: "flagged" });
    // Silently: the orders carry the flag for the operator, but no mail per order.
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
    expect(order(1200)).toMatchObject({ attentionOpen: true });
    expect(sendEmail).not.toHaveBeenCalled();
    // One error-level line for the workspace, however many attempts.
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([m]) =>
      String(m).includes(`sa=${SA}: open buy attempts on a key that is no longer connected`),
    );
    expect(logged).toHaveLength(1);
  }, 120_000);

  it("the read restarted after flagging asks nothing twice in one run", async () => {
    seedSub(OTHER_SA, OTHER_KEY);
    // The other workspace's still-ongoing buy is the oldest, so it is asked before the pile is met.
    seedBuy(5000, new Date(NOW.getTime() - 5 * HOUR), {}, B);
    for (let i = 1; i <= 150; i += 1) seedBuy(i, new Date(NOW.getTime() - HOUR - (2000 - i) * 1000 + 4 * HOUR));
    seedSub(SA, "sk_test_k9");
    verifyAnswer = (reference) => verified({ reference, status: "ongoing" });
    await expireStalePaystackOrders(AT);
    expect(calls.filter((c) => c.path.endsWith("/po-ord5000"))).toHaveLength(1);
  });

  it("open attempts on a gone key that the connection change somehow missed are flagged on sight, leaving the open read", async () => {
    seedBuy(1);
    seedSub(SA, OTHER_KEY);
    await expireStalePaystackOrders(NOW);
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
  });
});

describe("one workspace cannot starve the others", () => {
  const B = { sa: OTHER_SA, key: OTHER_KEY };

  beforeEach(() => seedSub(OTHER_SA, OTHER_KEY));

  it("25 old buys under a revoked key (401) do not stop another workspace's abandoned buy being asked", async () => {
    for (let i = 1; i <= 25; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    seedBuy(100, OLD, {}, B);
    verifyAnswer = (reference, auth) =>
      auth === `Bearer ${KEY}` ? refused(401, "Invalid key") : verified({ reference, status: "abandoned" });

    const summary = await expireStalePaystackOrders(NOW);
    expect(order(100)).toMatchObject({ status: "expired" });
    expect(attempt(100)).toMatchObject({ state: "refused" });
    // The revoked key cost three calls, not twenty-five.
    expect(calls.filter((c) => c.auth === `Bearer ${KEY}`)).toHaveLength(3);
    expect(summary).toMatchObject({ checked: 4, errors: 0, keyRejected: [SA], expired: 1, skipped: 22 });
    expect(order(1)).toMatchObject({ status: "pending" });
  });

  it("buys stuck 'ongoing' (under 7 days) are asked three times a run, not all", async () => {
    for (let i = 1; i <= 30; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    seedBuy(100, OLD, {}, B);
    verifyAnswer = (reference, auth) =>
      verified({ reference, status: auth === `Bearer ${KEY}` ? "ongoing" : "abandoned" });
    await expireStalePaystackOrders(NOW);
    expect(order(100)).toMatchObject({ status: "expired" });
    expect(calls.filter((c) => c.auth === `Bearer ${KEY}`)).toHaveLength(3);
  });

  it("reads past the first page: another workspace's buy behind 120 stuck rows is still reached", async () => {
    for (let i = 1; i <= 120; i += 1) seedBuy(i, new Date(OLD.getTime() - (1000 - i) * 1000));
    seedBuy(500, OLD, {}, B);
    verifyAnswer = (reference, auth) =>
      verified({ reference, status: auth === `Bearer ${KEY}` ? "ongoing" : "abandoned" });
    await expireStalePaystackOrders(NOW);
    expect(order(500)).toMatchObject({ status: "expired" });
  });

  it("a workspace whose first asks resolve is not capped: its 25 abandoned buys all expire", async () => {
    for (let i = 1; i <= 25; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 25, expired: 25 });
  });
});

describe("the run's summary", () => {
  it("counts an order expired only when the sweep actually changed it", async () => {
    seedBuy(1, OLD, { attention: "Held, check", attentionOpen: true });
    seedBuy(2);
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 2, expired: 1 });
    expect(order(1)).toMatchObject({ status: "pending" });
  });

  it("some asks failing is reported, not thrown", async () => {
    seedBuy(1, new Date(OLD.getTime() - 1000));
    seedBuy(2);
    verifyAnswer = (reference) => (reference === "po-ord1" ? "network-error" : verified({ reference, status: "abandoned" }));
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 2, errors: 1, expired: 1 });
  });

  describe("what makes the job fail", () => {
    const B = { sa: OTHER_SA, key: OTHER_KEY };
    beforeEach(() => seedSub(OTHER_SA, OTHER_KEY));

    it("a lone revoked-key workspace is reported in keyRejected, not thrown: the job stays 200", async () => {
      seedBuy(1);
      seedBuy(2);
      verifyAnswer = () => refused(401, "Invalid key");
      const summary = await expireStalePaystackOrders(NOW);
      expect(summary).toMatchObject({ errors: 0, keyRejected: [SA] });
      expect(order(1)).toMatchObject({ status: "pending" });
    });

    it("a 403 is a key refusal too", async () => {
      seedBuy(1);
      verifyAnswer = () => refused(403, "Forbidden");
      await expect(expireStalePaystackOrders(NOW)).resolves.toMatchObject({ errors: 0, keyRejected: [SA] });
    });

    it("every ask failing on the network across two workspaces is a Paystack outage: it throws", async () => {
      seedBuy(1);
      seedBuy(2, OLD, {}, B);
      verifyAnswer = () => "network-error";
      await expect(expireStalePaystackOrders(NOW)).rejects.toThrow(/all 2 Paystack ask\(s\) failed across 2 workspaces/);
      expect(order(1)).toMatchObject({ status: "pending" });
    });

    it("so is a run of 5xx answers", async () => {
      seedBuy(1);
      seedBuy(2, OLD, {}, B);
      verifyAnswer = () => refused(503, "Service unavailable");
      await expect(expireStalePaystackOrders(NOW)).rejects.toThrow(/failed across 2 workspaces/);
    });

    it("every ask refused (401/403) across two workspaces never throws: logged at error level, reported in the summary", async () => {
      seedBuy(1);
      seedBuy(2, OLD, {}, B);
      verifyAnswer = (_ref, auth) => (auth === `Bearer ${KEY}` ? refused(401, "Invalid key") : refused(403, "Forbidden"));
      const summary = await expireStalePaystackOrders(NOW);
      expect(summary).toMatchObject({ checked: 2, errors: 0 });
      expect(summary.keyRejected.sort()).toEqual([SA, OTHER_SA].sort());
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Paystack rejected keys in 2 workspaces"));
      expect(order(1)).toMatchObject({ status: "pending" });
    });

    it("every ask refused in ONE workspace is just that workspace's key", async () => {
      seedBuy(1);
      seedBuy(2);
      verifyAnswer = () => refused(401, "Invalid key");
      await expect(expireStalePaystackOrders(NOW)).resolves.toMatchObject({ keyRejected: [SA] });
    });

    it("Firestore failing inside an ask is a write error, never mislabelled as a Paystack outage", async () => {
      seedBuy(1);
      seedBuy(2, OLD, {}, B);
      const tx = vi.spyOn(mem.db, "runTransaction").mockRejectedValue(new Error("firestore unavailable"));
      const summary = await expireStalePaystackOrders(NOW);
      tx.mockRestore();
      expect(summary).toMatchObject({ checked: 2, errors: 0, writeErrors: 2, expired: 0 });
      expect(order(1)).toMatchObject({ status: "pending" });
    });

    it("a payment found but not recorded because Firestore failed is a write error, not a failed ask", async () => {
      seedBuy(1);
      seedBuy(2, OLD, {}, B);
      verifyAnswer = (reference) => verified({ reference, status: "success", amount: 49_900 });
      const tx = vi.spyOn(mem.db, "runTransaction").mockRejectedValue(new Error("firestore unavailable"));
      const summary = await expireStalePaystackOrders(NOW);
      tx.mockRestore();
      expect(summary).toMatchObject({ checked: 2, errors: 0, writeErrors: 2, reconciled: 0 });
    });

    it("closing an attempt whose key is gone, with Firestore failing, is a write error too", async () => {
      seedBuy(1);
      seedSub(SA, OTHER_KEY);
      const tx = vi.spyOn(mem.db, "runTransaction").mockRejectedValue(new Error("firestore unavailable"));
      const summary = await expireStalePaystackOrders(new Date(NOW.getTime() + 48 * HOUR));
      tx.mockRestore();
      expect(summary).toMatchObject({ writeErrors: 1, retired: 0, errors: 0 });
    });

    it("a Paystack outage is still an outage when some writes also fail", async () => {
      seedBuy(1);
      seedBuy(2, OLD, {}, B);
      verifyAnswer = () => "network-error";
      await expect(expireStalePaystackOrders(NOW)).rejects.toThrow(/failed across 2 workspaces/);
    });

    it("the same outage seen by one workspace only is reported, not thrown", async () => {
      seedBuy(1);
      seedBuy(2);
      verifyAnswer = () => "network-error";
      await expect(expireStalePaystackOrders(NOW)).resolves.toMatchObject({ checked: 2, errors: 2 });
    });

    it("one workspace's revoked key beside another's network failure is not an outage", async () => {
      seedBuy(1);
      seedBuy(2, OLD, {}, B);
      verifyAnswer = (_ref, auth) => (auth === `Bearer ${KEY}` ? refused(401, "Invalid key") : "network-error");
      await expect(expireStalePaystackOrders(NOW)).resolves.toMatchObject({ errors: 1, keyRejected: [SA] });
    });
  });

  it("nothing to ask is not a failure", async () => {
    verifyAnswer = () => "network-error";
    await expect(expireStalePaystackOrders(NOW)).resolves.toMatchObject({ checked: 0, errors: 0 });
  });
});

describe("a buy paid after all", () => {
  it("is reconciled like a webhook: paid, one email (also hears a webhook that was never registered)", async () => {
    seedBuy(1);
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 49_900 });
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 1, reconciled: 1, expired: 0 });
    await flushAfterResponse();
    expect(order(1)).toMatchObject({ status: "paid" });
    expect(attempt(1)).toMatchObject({ state: "settled" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a payment for another amount is held, not paid and not expired", async () => {
    seedBuy(1);
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 100 });
    await expireStalePaystackOrders(NOW);
    expect(order(1)).toMatchObject({ status: "pending", attentionOpen: true });
    expect(order(1).heldAt).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a payment that lands after the order expired is flagged, never dropped", async () => {
    seedBuy(1);
    await expireStalePaystackOrders(NOW);
    verifyAnswer = (reference) => verified({ reference, status: "success", amount: 49_900 });
    const { reconcilePaystackCharge } = await import("@/lib/paystack/payment-link-reconciler");
    await reconcilePaystackCharge({ subAccountId: SA, secretKey: KEY, reference: "po-ord1" });
    expect(order(1)).toMatchObject({ status: "expired", attentionOpen: true });
    expect(order(1).attention).toMatch(/already expired/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("the batch", () => {
  it(`asks Paystack about at most ${EXPIRY_BATCH} attempts a run, oldest first`, async () => {
    for (let i = 1; i <= EXPIRY_BATCH + 5; i += 1) seedBuy(i, new Date(OLD.getTime() - (100 - i) * 1000));
    const first = await expireStalePaystackOrders(NOW);
    expect(first).toMatchObject({ checked: EXPIRY_BATCH, expired: EXPIRY_BATCH });
    expect(calls).toHaveLength(EXPIRY_BATCH);
    expect(order(1)).toMatchObject({ status: "expired" });
    expect(order(EXPIRY_BATCH + 5)).toMatchObject({ status: "pending" });
    // The rest wait for the next run.
    expect(await expireStalePaystackOrders(NOW)).toMatchObject({ checked: 5, expired: 5 });
  });

  it("stops asking when the run's time budget is spent", async () => {
    seedBuy(1);
    seedBuy(2);
    expect(await expireStalePaystackOrders(NOW, -1)).toMatchObject({ checked: 0, overBudget: 2 });
    expect(calls).toHaveLength(0);
  });
});

describe("a key change", () => {
  it("after expiry flags nothing: the expired buys left the open set", async () => {
    seedBuy(1);
    await expireStalePaystackOrders(NOW);
    await flagStaleAttempts(SA, null);
    expect(attempt(1)).toMatchObject({ state: "refused" });
    expect(order(1).attention ?? null).toBeNull();
  });

  it("before expiry still flags an open buy, on the order too", async () => {
    seedBuy(1, new Date(NOW.getTime() - HOUR));
    await flagStaleAttempts(SA, null);
    expect(attempt(1)).toMatchObject({ state: "flagged" });
    expect(order(1)).toMatchObject({ attentionOpen: true });
  });
});
