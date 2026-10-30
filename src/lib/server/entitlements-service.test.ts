import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyMemberMagicLinkToken } from "@/lib/community/member-auth";
import { SA, mem, seedSub } from "@/test/paystack-links-harness";

/**
 * Seam test: the REAL entitlements service over the REAL community member,
 * membership and purchase services, on an in-memory Firestore. Only outbound
 * mail and the workflow/webhook fan-out are stubbed. Every seeded doc carries
 * its tenancy keys (agencyId + subAccountId), as production writes do.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => {}) }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const sendEmail = vi.hoisted(() =>
  vi.fn(async (_m: { to: string; subject: string; text: string; html?: string }) => ({ id: "m1" })),
);
vi.mock("@/lib/comms/resend", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/resend")>()),
  sendEmail,
}));

const { flushAfterResponse } = await import("@/lib/server/after-response");
const { renderOrderConfirmation } = await import("@/lib/server/order-confirmation-service");
const { entitlementId, grantForOrder, revokeForOrder } = await import(
  "@/lib/server/entitlements-service"
);
const { createPurchaseForOrderServerSide, markPurchasePaidServerSide, requestPurchaseServerSide } = await import(
  "@/lib/server/community-purchase-service"
);

const AG = "ag1";
const OTHER_SA = "sa2";
const DOWNLOAD = "https://files.example.com/guide.pdf";
const target = { orderId: "ord1", subAccountId: SA };
const COMMUNITY = { type: "community", communityGroupId: "g1", courseId: null } as const;

function seedGroup() {
  mem.seed(`subAccounts/${SA}/communityGroups/g1`, {
    subAccountId: SA,
    agencyId: AG,
    name: "Fibre Club",
    slug: "fibre-club",
    access: "free",
    status: "published",
    memberCount: 0,
  });
}

function seedOrder(over: Record<string, unknown> = {}, id = "ord1") {
  mem.seed(`orders/${id}`, {
    agencyId: AG,
    subAccountId: SA,
    contactId: null,
    checkoutPageId: null,
    quoteId: null,
    source: "product_link",
    status: "paid",
    currency: "zar",
    subtotalCents: 49_900,
    totalCents: 49_900,
    refundedCents: 0,
    stripeCheckoutSessionId: "",
    stripePaymentIntentId: null,
    livemode: false,
    buyerEmail: "buyer@example.com",
    buyerName: "Bea Buyer",
    productLinkProductId: "p1",
    lineItems: [{ productId: "p1", name: "Fibre club", description: "", unitPriceCents: 49_900, quantity: 1, isBump: false }],
    deliveries: [{ productId: "p1", delivery: COMMUNITY }],
    ...over,
  });
}

const entitlement = () => mem.read(`entitlements/${entitlementId("ord1", "p1")}`);
const order = () => mem.read("orders/ord1")!;
const deliveryError = () => (order().deliveryStatus as { error: string | null }).error ?? "";
const purchases = () => mem.list(`subAccounts/${SA}/communityGroups/g1/purchases`);
const memberships = () => mem.list(`subAccounts/${SA}/communityGroups/g1/memberships`);
const group = () => mem.read(`subAccounts/${SA}/communityGroups/g1`)!;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "shop@example.com";
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  seedSub();
  mem.seed(`subAccounts/${SA}`, {
    agencyId: AG,
    name: "Acme Fibre",
    communityEnabledByAgency: true,
    paymentsEnabledByAgency: true,
  });
  seedGroup();
  seedOrder();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("community grant", () => {
  it("grants access once: member, membership, a paid order-backed purchase, one sign-in email", async () => {
    const summary = await grantForOrder(target);
    await flushAfterResponse();

    expect(summary).toEqual({ delivered: 1, failed: 0, skipped: 0 });
    expect(entitlement()).toMatchObject({
      agencyId: AG,
      subAccountId: SA,
      orderId: "ord1",
      productId: "p1",
      status: "active",
      sends: 1,
      fulfilment: { state: "done", error: null },
    });
    const members = mem.list(`subAccounts/${SA}/members`);
    expect(members).toEqual([expect.objectContaining({ email: "buyer@example.com", status: "active" })]);
    expect(memberships()).toEqual([
      expect.objectContaining({ memberId: members[0].id, status: "active", subAccountId: SA, agencyId: AG }),
    ]);
    expect(group().memberCount).toBe(1);
    expect(purchases()).toEqual([
      expect.objectContaining({
        id: "order_ord1_p1_g",
        status: "paid",
        orderId: "ord1",
        paidOrderId: "ord1",
        amountCents: 0,
        grantedByUid: "system:product-order",
        subAccountId: SA,
        agencyId: AG,
      }),
    ]);
    expect(order().deliveryStatus).toMatchObject({ state: "done", error: null });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("buyer@example.com");
    expect(mail.subject).toBe("Your access to Fibre club");
    // The link is a real, group-scoped, 24-hour magic link for THIS buyer.
    const token = new URL(mail.text.match(/https:\/\/\S+/)![0]).searchParams.get("token")!;
    const verified = verifyMemberMagicLinkToken(token)!;
    expect(verified).toMatchObject({ subAccountId: SA, email: "buyer@example.com", joinGroupId: "g1" });
    expect(verified.exp - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it("the delivery is recorded on the buyer's contact timeline", async () => {
    seedOrder({ contactId: "c1" });
    await grantForOrder(target);
    expect(entitlement()).toMatchObject({ contactId: "c1" });
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ type: "product_delivered", meta: { orderId: "ord1" } }),
    ]);
  });

  it("the sign-in email is not archived to Conversations (its link is a live sign-in)", async () => {
    await grantForOrder(target);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ archive: false });
  });

  it("a replay produces one grant: one entitlement, one purchase, one member count, one email", async () => {
    await grantForOrder(target);
    const again = await grantForOrder(target);
    await grantForOrder(target);
    await flushAfterResponse();

    expect(again).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(mem.list("entitlements")).toHaveLength(1);
    expect(entitlement()!.sends).toBe(1);
    expect(purchases()).toHaveLength(1);
    expect(memberships()).toHaveLength(1);
    expect(group().memberCount).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("concurrent payment confirmations produce one grant", async () => {
    const results = await Promise.all([
      grantForOrder(target),
      grantForOrder(target),
      grantForOrder(target),
    ]);
    await flushAfterResponse();

    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(1);
    expect(mem.list("entitlements")).toHaveLength(1);
    expect(purchases()).toHaveLength(1);
    expect(memberships()).toHaveLength(1);
    expect(mem.list(`subAccounts/${SA}/members`)).toHaveLength(1);
    expect(group().memberCount).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a slow send still pending at +3 minutes keeps its claim: exactly one email goes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let finish!: () => void;
    sendEmail.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ id: "m1" }); }));
    const t0 = Date.now();

    const slow = grantForOrder(target);
    // Let the first run reach the (hung) send.
    while (sendEmail.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
    vi.setSystemTime(t0 + 3 * 60_000);
    const second = await grantForOrder(target);
    expect(second).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    finish();
    expect(await slow).toMatchObject({ delivered: 1 });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(entitlement()!.sends).toBe(1);
  });

  it("a claim whose holder died is retaken after the lease", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    mem.seed("entitlements/ord1_p1", {
      agencyId: AG, subAccountId: SA, orderId: "ord1", productId: "p1", status: "active", sends: 0,
      delivery: COMMUNITY, fulfilment: { state: "sending", error: null, at: t0 },
    });
    vi.setSystemTime(t0 + 5 * 60_000);
    expect(await grantForOrder(target)).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    vi.setSystemTime(t0 + 11 * 60_000);
    expect(await grantForOrder(target)).toMatchObject({ delivered: 1 });
  });

  it("two purchases for one member in one group count the member once, however they overlap", async () => {
    const base = { subAccountId: SA, agencyId: AG, groupId: "g1", scope: "group" as const, targetId: "g1", memberId: "m1", currency: "zar" };
    await createPurchaseForOrderServerSide({ ...base, orderId: "ordA", purchaseId: "order_ordA_p1_g" });
    await createPurchaseForOrderServerSide({ ...base, orderId: "ordB", purchaseId: "order_ordB_p1_g" });
    await Promise.all(["order_ordA_p1_g", "order_ordB_p1_g"].map((purchaseId) =>
      markPurchasePaidServerSide({ subAccountId: SA, groupId: "g1", purchaseId, grantedByUid: "system:product-order" })));

    expect(group().memberCount).toBe(1);
    expect(memberships()).toEqual([expect.objectContaining({ memberId: "m1", status: "active" })]);
  });

  it("the sign-in email says the link works once and keeps the fallback sentence", async () => {
    await grantForOrder(target);
    const { text, html } = sendEmail.mock.calls[0][0] as unknown as { text: string; html: string };
    expect(text).toContain("The link works once, for up to 24 hours. After that, sign in at");
    expect(text).toContain("we'll send you a fresh link");
    expect(html).toContain("works once, for up to 24 hours");
  });

  it("a course product grants its group and a paid course purchase", async () => {
    mem.seed(`subAccounts/${SA}/communityGroups/g1/courses/c1`, {
      subAccountId: SA,
      agencyId: AG,
      title: "Splicing 101",
      access: "open",
    });
    seedOrder({ deliveries: [{ productId: "p1", delivery: { ...COMMUNITY, courseId: "c1" } }] });
    await grantForOrder(target);
    await flushAfterResponse();

    expect(purchases().map((p) => [p.id, p.scope, p.status]).sort()).toEqual([
      ["order_ord1_p1_c", "course", "paid"],
      ["order_ord1_p1_g", "group", "paid"],
    ]);
    expect(sendEmail.mock.calls[0][0].text).toContain("the Splicing 101 course in Fibre Club");
  });

  it("an already-active member keeps their role and is not counted twice", async () => {
    mem.seed(`subAccounts/${SA}/members/m1`, {
      subAccountId: SA, agencyId: AG, email: "buyer@example.com", status: "active", displayName: null,
    });
    mem.seed(`subAccounts/${SA}/communityGroups/g1/memberships/m1`, {
      subAccountId: SA, agencyId: AG, groupId: "g1", memberId: "m1", role: "moderator", status: "active",
    });
    mem.seed(`subAccounts/${SA}/communityGroups/g1`, { ...group(), memberCount: 1 });
    await grantForOrder(target);

    expect(memberships()).toEqual([expect.objectContaining({ memberId: "m1", role: "moderator" })]);
    expect(group().memberCount).toBe(1);
    expect(purchases()).toHaveLength(0);
    expect(entitlement()).toMatchObject({ fulfilment: { state: "done" } });
  });
});

describe("no grant unless the order is owed one", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["pending", { status: "pending" }],
    ["refunded", { status: "refunded", refundedCents: 49_900 }],
    ["failed", { status: "failed" }],
    ["expired", { status: "expired" }],
    ["held", { status: "pending", heldAt: new Date(), attention: "Paid a different amount.", attentionOpen: true }],
    ["held even if (wrongly) paid", { heldAt: new Date() }],
    ["flagged", { attention: "Paid, but this order was already expired.", attentionOpen: true }],
    ["flagged before resolution existed", { attention: "Needs a look." }],
    ["not a product link", { source: "checkout_page" }],
    ["nothing to deliver", { deliveries: [] }],
  ];
  it.each(cases)("%s order: no entitlement, member, purchase or email", async (_name, over) => {
    seedOrder(over);
    const summary = await grantForOrder(target);
    await flushAfterResponse();

    expect(summary).toEqual({ delivered: 0, failed: 0, skipped: 0 });
    expect(mem.list("entitlements")).toHaveLength(0);
    expect(mem.list(`subAccounts/${SA}/members`)).toHaveLength(0);
    expect(purchases()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(order().deliveryStatus ?? null).toBeNull();
  });

  it("a resolved flag no longer blocks, so staff can re-send", async () => {
    seedOrder({ attention: "Reviewed.", attentionOpen: false });
    expect(await grantForOrder(target, { resend: true })).toMatchObject({ delivered: 1 });
  });

  it("a refund that lands after the order was read still stops the grant (claim re-reads the order)", async () => {
    const real = mem.db.doc;
    let flipped = false;
    vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      // The sub-account read sits between the grant's first order read and its claim.
      if (path === `subAccounts/${SA}` && !flipped) {
        flipped = true;
        mem.seed("orders/ord1", { ...order(), status: "refunded", refundedCents: 49_900 });
      }
      return real(path);
    });
    const summary = await grantForOrder(target);

    expect(flipped).toBe(true);
    expect(summary).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(mem.list("entitlements")).toHaveLength(0);
    expect(purchases()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // A refund can land after the claim, while the grant is half done. Whatever
  // happens first after `when` fires, the order is refunded; nothing may be mailed.
  function refundWhen(when: (path: string, n: number) => boolean) {
    const real = mem.db.doc;
    const reads = new Map<string, number>();
    let flipped = false;
    const spy = vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      const n = (reads.get(path) ?? 0) + 1;
      reads.set(path, n);
      if (!flipped && when(path, n)) {
        flipped = true;
        mem.seed("orders/ord1", { ...order(), status: "refunded", refundedCents: 49_900 });
      }
      return real(path);
    });
    return { flipped: () => flipped, restore: () => spy.mockRestore() };
  }

  it("a refund that lands after the claim, before the community email: nothing mailed, entitlement revoked", async () => {
    const race = refundWhen((p) => /\/memberships\//.test(p));
    const summary = await grantForOrder(target);

    expect(race.flipped()).toBe(true);
    expect(summary).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(entitlement()).toMatchObject({ status: "revoked", subAccountId: SA });
    expect(order().deliveryStatus ?? null).toBeNull();
    // A later re-send must not deliver it either.
    race.restore();
    seedOrder({ status: "paid" });
    expect(await grantForOrder(target, { resend: true })).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a refund that lands after the claim, before the download email: nothing mailed, entitlement revoked", async () => {
    seedOrder({ deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get it" } }] });
    // orders/ord1 is opened for the first read, the claim, then the pre-send check.
    const race = refundWhen((p, n) => p === "orders/ord1" && n === 3);
    const summary = await grantForOrder(target);

    expect(race.flipped()).toBe(true);
    expect(summary).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(entitlement()).toMatchObject({ status: "revoked" });
  });

  it("a hold or flag that lands before the email also stops it", async () => {
    const real = mem.db.doc;
    vi.spyOn(mem.db, "doc").mockImplementation((path: string) => {
      if (/\/memberships\//.test(path)) mem.seed("orders/ord1", { ...order(), attention: "Flagged.", attentionOpen: true });
      return real(path);
    });
    await grantForOrder(target);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(entitlement()).toMatchObject({ status: "revoked" });
  });

  it("another sub-account's id grants nothing", async () => {
    mem.seed(`subAccounts/${OTHER_SA}`, { agencyId: AG, name: "Other", communityEnabledByAgency: true });
    const summary = await grantForOrder({ orderId: "ord1", subAccountId: OTHER_SA });

    expect(summary).toEqual({ delivered: 0, failed: 0, skipped: 0 });
    expect(mem.list("entitlements")).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an unknown order grants nothing", async () => {
    expect(await grantForOrder({ orderId: "nope", subAccountId: SA })).toEqual({
      delivered: 0, failed: 0, skipped: 0,
    });
  });
});

describe("a delivery that cannot happen is recorded on the order, never thrown", () => {
  it("a banned member gets a DeliveryError on the order and the entitlement, and no access", async () => {
    mem.seed(`subAccounts/${SA}/members/m1`, {
      subAccountId: SA, agencyId: AG, email: "buyer@example.com", status: "active", displayName: null,
    });
    mem.seed(`subAccounts/${SA}/communityGroups/g1/memberships/m1`, {
      subAccountId: SA, agencyId: AG, groupId: "g1", memberId: "m1", role: "member", status: "banned",
    });
    const summary = await grantForOrder(target);

    expect(summary).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    expect(order().deliveryStatus).toMatchObject({ state: "failed" });
    expect(deliveryError()).toMatch(/banned from the group/);
    expect(entitlement()).toMatchObject({
      subAccountId: SA,
      fulfilment: { state: "failed", error: expect.stringMatching(/banned/) },
    });
    expect(memberships()).toEqual([expect.objectContaining({ status: "banned" })]);
    expect(purchases()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a deactivated member gets a DeliveryError on the order", async () => {
    mem.seed(`subAccounts/${SA}/members/m1`, {
      subAccountId: SA, agencyId: AG, email: "buyer@example.com", status: "removed", displayName: null,
    });
    const summary = await grantForOrder(target);

    expect(summary).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    expect(deliveryError()).toMatch(/deactivated/);
    expect(memberships()).toHaveLength(0);
    expect(purchases()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a draft group is not granted into: a clear DeliveryError, no member, purchase or email", async () => {
    mem.seed(`subAccounts/${SA}/communityGroups/g1`, { ...group(), status: "draft" });
    const summary = await grantForOrder(target);

    expect(summary).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    expect(deliveryError()).toMatch(/isn't published/);
    expect(mem.list(`subAccounts/${SA}/members`)).toHaveLength(0);
    expect(memberships()).toHaveLength(0);
    expect(purchases()).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a group with no status (legacy or tampered) is not granted into either", async () => {
    const { status: _s, ...noStatus } = group();
    mem.seed(`subAccounts/${SA}/communityGroups/g1`, noStatus);
    await grantForOrder(target);
    expect(deliveryError()).toMatch(/isn't published/);
    expect(purchases()).toHaveLength(0);
  });

  it("a deleted group is recorded, not thrown", async () => {
    mem.clear();
    mem.seed(`subAccounts/${SA}`, { agencyId: AG, name: "Acme Fibre", communityEnabledByAgency: true });
    seedOrder();
    await grantForOrder(target);
    expect(deliveryError()).toMatch(/group no longer exists/);
  });

  it("failed deliveries are retried by the next confirmation, and the roll-up flips to done", async () => {
    mem.seed(`subAccounts/${SA}/members/m1`, {
      subAccountId: SA, agencyId: AG, email: "buyer@example.com", status: "removed", displayName: null,
    });
    await grantForOrder(target);
    expect(order().deliveryStatus).toMatchObject({ state: "failed" });

    mem.seed(`subAccounts/${SA}/members/m1`, {
      subAccountId: SA, agencyId: AG, email: "buyer@example.com", status: "active", displayName: null,
    });
    expect(await grantForOrder(target)).toMatchObject({ delivered: 1, failed: 0 });
    expect(order().deliveryStatus).toMatchObject({ state: "done", error: null });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("access granted but Community switched off: recorded as failed, nothing mailed", async () => {
    mem.seed(`subAccounts/${SA}`, { agencyId: AG, name: "Acme Fibre", communityEnabledByAgency: false });
    await grantForOrder(target);

    expect(purchases()).toEqual([expect.objectContaining({ status: "paid" })]);
    expect(deliveryError()).toMatch(/Community is turned off/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("an order with no buyer email records it", async () => {
    seedOrder({ buyerEmail: null });
    await grantForOrder(target);
    expect(deliveryError()).toMatch(/no buyer email/);
  });

  it("a failing mail send is recorded generically, with no provider detail", async () => {
    sendEmail.mockRejectedValueOnce(new Error("SMTP password hunter2 rejected"));
    await grantForOrder(target);

    const error = deliveryError();
    expect(error).toMatch(/Re-send delivery/);
    expect(error).not.toContain("hunter2");
    expect(entitlement()!.fulfilment).toMatchObject({ state: "failed" });
  });
});

describe("anything that reaches an email subject is one clean line", () => {
  const EVIL = "Guide\r\nBcc: evil@example.com\u0000\u2028x";
  const clean = (subject: string) => {
    expect(subject).not.toMatch(/[\r\n\u0000-\u001f\u2028\u2029]/);
    expect(subject).toContain("Bcc: evil@example.com");
  };

  it("community email", async () => {
    seedOrder({ lineItems: [{ productId: "p1", name: EVIL, description: "", unitPriceCents: 1, quantity: 1, isBump: false }] });
    await grantForOrder(target);
    clean(sendEmail.mock.calls[0][0].subject);
    expect(sendEmail.mock.calls[0][0].subject).toBe("Your access to Guide Bcc: evil@example.com x");
  });

  it("download email", async () => {
    seedOrder({
      lineItems: [{ productId: "p1", name: EVIL, description: "", unitPriceCents: 1, quantity: 1, isBump: false }],
      deliveries: [{ productId: "p1", delivery: { type: "download", url: DOWNLOAD, label: "Get it" } }],
    });
    await grantForOrder(target);
    clean(sendEmail.mock.calls[0][0].subject);
  });

  it("order confirmation", () => {
    const { subject } = renderOrderConfirmation(
      { ...order(), id: "ord1", lineItems: [{ productId: "p1", name: EVIL, description: "", unitPriceCents: 1, quantity: 1, isBump: false }] } as never,
      { name: "Acme" },
    );
    clean(subject);
  });

  it("a name that is only control characters falls back to a plain subject", async () => {
    seedOrder({ lineItems: [{ productId: "p1", name: "\r\n\t", description: "", unitPriceCents: 1, quantity: 1, isBump: false }] });
    await grantForOrder(target);
    expect(sendEmail.mock.calls[0][0].subject).toBe("Your access to your purchase");
  });
});

describe("download delivery", () => {
  const seedDownload = (over: Record<string, unknown> = {}, url = DOWNLOAD) =>
    seedOrder({
      deliveries: [{ productId: "p1", delivery: { type: "download", url, label: "Get the guide" } }],
      ...over,
    });

  it("emails the link when the confirmation did not carry it", async () => {
    seedDownload();
    await grantForOrder(target);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "buyer@example.com", subject: "Your download: Fibre club" });
    expect(sendEmail.mock.calls[0][0].text).toContain(DOWNLOAD);
    expect(entitlement()).toMatchObject({ fulfilment: { state: "done" }, sends: 1 });
  });

  it("sends no second email when the order confirmation already carried the link", async () => {
    seedDownload({ confirmationEmail: { state: "sent", error: null, at: 1 } });
    await grantForOrder(target);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(entitlement()).toMatchObject({ fulfilment: { state: "done" } });
    expect(order().deliveryStatus).toMatchObject({ state: "done" });
  });

  it("the download email is sent against the buyer's contact", async () => {
    seedDownload({ contactId: "c1" });
    await grantForOrder(target);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ contactId: "c1" });
  });

  it("a failed confirmation does not suppress the delivery email", async () => {
    seedDownload({ confirmationEmail: { state: "failed", error: "refused", at: 1 } });
    await grantForOrder(target);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a link the confirmation could not carry is still emailed", async () => {
    // Plain http is not a public https link: refused at the sink, recorded.
    seedDownload({ confirmationEmail: { state: "sent", error: null, at: 1 } }, "http://files.example.com/guide.pdf");
    await grantForOrder(target);
    expect(deliveryError()).toMatch(/isn't a valid https link/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("staff Re-send delivery mails the link again even after a confirmation, and creates no second entitlement", async () => {
    seedDownload({ confirmationEmail: { state: "sent", error: null, at: 1 } });
    await grantForOrder(target);
    expect(sendEmail).not.toHaveBeenCalled();

    const again = await grantForOrder(target, { resend: true });
    expect(again).toMatchObject({ delivered: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mem.list("entitlements")).toHaveLength(1);
    expect(entitlement()!.sends).toBe(2);
  });

  it("Re-send on a community grant mails a fresh link and does not grant twice", async () => {
    await grantForOrder(target);
    await grantForOrder(target, { resend: true });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(purchases()).toHaveLength(1);
    expect(memberships()).toHaveLength(1);
    expect(group().memberCount).toBe(1);
    expect(entitlement()!.sends).toBe(2);
  });
});

describe("refund", () => {
  it("revokes the entitlement, and a later re-send skips it", async () => {
    await grantForOrder(target);
    const revoked = await revokeForOrder({ id: "ord1", ...order() } as never);
    expect(revoked).toBe(1);
    expect(entitlement()).toMatchObject({ status: "revoked" });

    seedOrder({ status: "partially_refunded" });
    const again = await grantForOrder(target, { resend: true });
    expect(again).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("revoke is idempotent and never touches another sub-account's entitlement", async () => {
    await grantForOrder(target);
    const ord = { id: "ord1", ...order() } as never;
    expect(await revokeForOrder({ ...(ord as object), subAccountId: OTHER_SA } as never)).toBe(0);
    expect(entitlement()).toMatchObject({ status: "active" });
    expect(await revokeForOrder(ord)).toBe(1);
    expect(await revokeForOrder(ord)).toBe(0);
  });
});

describe("order-backed purchases", () => {
  it("creating one twice returns the same doc and does not reset it", async () => {
    const input = {
      subAccountId: SA, agencyId: AG, groupId: "g1", scope: "group" as const, targetId: "g1",
      memberId: "m1", currency: "zar", orderId: "ord1", purchaseId: "order_ord1_p1_g",
    };
    await createPurchaseForOrderServerSide(input);
    mem.seed(`subAccounts/${SA}/communityGroups/g1/purchases/order_ord1_p1_g`, {
      ...purchases()[0], status: "paid",
    });
    await createPurchaseForOrderServerSide(input);
    expect(purchases()).toEqual([expect.objectContaining({ status: "paid" })]);
  });

  it("a member's own purchase request never reuses an order-backed pending purchase (it carries amount 0)", async () => {
    mem.seed(`subAccounts/${SA}/communityGroups/g1`, { ...group(), access: "paid", priceCents: 5_000, currency: "ZAR" });
    mem.seed(`subAccounts/${SA}`, {
      agencyId: AG, name: "Acme Fibre", communityEnabledByAgency: true, paypalConfig: { username: "acme" },
    });
    await createPurchaseForOrderServerSide({
      subAccountId: SA, agencyId: AG, groupId: "g1", scope: "group", targetId: "g1",
      memberId: "m1", currency: "zar", orderId: "ord1", purchaseId: "order_ord1_p1_g",
    });
    const res = await requestPurchaseServerSide({
      subAccountId: SA, groupId: "g1", memberId: "m1", scope: "group", targetId: "g1",
    });

    expect(res.purchaseId).not.toBe("order_ord1_p1_g");
    expect(res.amountCents).toBe(5_000);
    expect(purchases()).toHaveLength(2);
  });
});
