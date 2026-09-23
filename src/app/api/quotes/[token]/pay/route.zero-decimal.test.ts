import { beforeEach, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Zero-decimal currencies (JPY, KRW, …) are whole units at Stripe. The card
 * checkout must send ¥1,150 as 1150, not 115000 — a 100× overcharge.
 */

const mem = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createMemoryFirestore> }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db.db }));
vi.mock("@/lib/quotes/token", () => ({ verifyQuoteToken: () => ({ quoteId: "inv1", hash: "h1" }) }));
vi.mock("@/lib/checkout/rate-limit", () => ({ checkCheckoutRateLimit: () => ({ ok: true }), clientIpFrom: () => "ip" }));
const stripe = vi.hoisted(() => ({
  createCheckoutSessionForSubAccount: vi.fn(async (_: unknown) => ({ id: "cs_1", url: "https://stripe.test/cs_1", livemode: false })),
  getSubAccountStripe: vi.fn(async () => ({})),
  StripeConnectionError: class extends Error {},
}));
vi.mock("@/lib/stripe/sub-account-client", () => stripe);

mem.db = createMemoryFirestore();
const { POST } = await import("./route");

function seed(currency: string) {
  mem.db.seed("subAccounts/sa1", { paymentsEnabledByAgency: true });
  mem.db.seed("quotes/inv1", {
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: "c1",
    kind: "invoice",
    status: "sent",
    quoteNumber: "INV-1",
    currency,
    publicTokenHash: "h1",
    lineItems: [{ id: "li1", description: "Install", quantity: 1, unitPrice: 1000 }],
    globalDiscount: null,
    globalTaxPercent: 15,
  });
}

const pay = () => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ token: "t" }) });
const unitAmount = () =>
  (stripe.createCheckoutSessionForSubAccount.mock.calls[0][0] as {
    params: { line_items: { price_data: { unit_amount: number } }[] };
  }).params.line_items[0].price_data.unit_amount;

beforeEach(() => {
  mem.db.clear();
  vi.clearAllMocks();
});

it("charges a JPY invoice in whole yen", async () => {
  seed("JPY");
  expect((await pay()).status).toBe(200);
  expect(unitAmount()).toBe(1150);
});

it("still charges a two-decimal invoice in cents", async () => {
  seed("ZAR");
  expect((await pay()).status).toBe(200);
  expect(unitAmount()).toBe(115000);
});
