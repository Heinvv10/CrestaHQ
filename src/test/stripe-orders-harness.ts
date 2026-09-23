import Stripe from "stripe";
import { vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Shared fixture for the sub-account Stripe webhook seam tests: signed event →
 * real route → real reconciler → real services over an in-memory Firestore.
 *
 *   vi.mock("@/lib/firebase/admin", async () =>
 *     (await import("@/test/stripe-orders-harness")).adminMock());
 *
 * No app imports that reach the admin module — the mock factory loads this.
 */

export const mem = createMemoryFirestore();
export const adminMock = () => ({ getAdminDb: () => mem.db });

export const SA = "sa1";
export const SECRET = "whsec_test_1";

type Post = (req: Request, ctx: { params: Promise<{ subAccountId: string }> }) => Promise<Response>;

export function deliverTo(post: Post) {
  return (type: string, object: Record<string, unknown>, id = "evt_1") => {
    const payload = JSON.stringify({ id, object: "event", type, data: { object } });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    return post(
      new Request(`http://x/api/webhooks/stripe/sa/${SA}`, {
        method: "POST",
        headers: { "stripe-signature": header },
        body: payload,
      }),
      { params: Promise.resolve({ subAccountId: SA }) },
    );
  };
}

export function seedConnection() {
  mem.seed(`subAccounts/${SA}/private/stripeConnection`, {
    mode: "key",
    restrictedKey: "rk_test_1",
    webhookSecret: SECRET,
  });
}

export const session = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  payment_status: "paid",
  payment_intent: `pi_${id}`,
  amount_total: 115000,
  currency: "zar",
  customer_details: { email: "payer@example.com", name: "Payer" },
  ...over,
});

/** A pending order for session `cs_{id}`, paying invoice inv1 R1,150.00. */
export function seedOrder(id: string, over: Record<string, unknown> = {}) {
  mem.seed(`orders/${id}`, {
    agencyId: "ag1",
    subAccountId: SA,
    contactId: null,
    checkoutPageId: null,
    quoteId: "inv1",
    eventId: null,
    communityGroupId: null,
    purchaseId: null,
    source: "quote",
    status: "pending",
    currency: "zar",
    lineItems: [],
    subtotalCents: 115000,
    totalCents: 115000,
    refundedCents: 0,
    stripeCheckoutSessionId: `cs_${id}`,
    stripePaymentIntentId: null,
    livemode: false,
    buyerEmail: null,
    buyerName: null,
    ...over,
  });
}

/** R1,150.00 — 1000 + 15% tax. */
export function seedInvoice(over: Record<string, unknown> = {}) {
  mem.seed("quotes/inv1", {
    agencyId: "ag1",
    subAccountId: SA,
    contactId: "c1",
    kind: "invoice",
    status: "sent",
    quoteNumber: "INV-1",
    currency: "ZAR",
    lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 1000 }],
    globalDiscount: null,
    globalTaxPercent: 15,
    ...over,
  });
}

/**
 * Make the first `method` call on any doc of `collection` reject with `err` —
 * a transient outage, or (code 5) a doc deleted under us. Both
 * `db.collection(c).doc(id)` and `db.doc("c/id")` are covered. Call the
 * returned function to restore.
 */
export function failFirst(
  collection: string,
  method: "get" | "update",
  err: Error = new Error("14 UNAVAILABLE"),
): () => void {
  const real = { collection: mem.db.collection, doc: mem.db.doc };
  let failed = false;
  type Ref = ReturnType<typeof real.doc>;
  const wrap = (ref: Ref, match: boolean): Ref => {
    if (!match) return ref;
    const orig = ref[method] as (...a: unknown[]) => Promise<never>;
    return {
      ...ref,
      [method]: (...args: unknown[]) =>
        failed ? orig(...args) : ((failed = true), Promise.reject(err)),
    };
  };
  const spies = [
    vi.spyOn(mem.db, "collection").mockImplementation((name: string) => {
      const col = real.collection(name);
      return Object.assign(Object.create(col), {
        doc: (id?: string) => wrap(col.doc(id), name === collection),
      });
    }),
    vi.spyOn(mem.db, "doc").mockImplementation((path: string) =>
      wrap(real.doc(path), path.slice(0, path.lastIndexOf("/")) === collection),
    ),
  ];
  return () => spies.forEach((s) => s.mockRestore());
}
