import { beforeEach, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/** A ¥5,000 deposit is 5000 at Stripe, not 500000. */

const mem = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createMemoryFirestore> }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db.db }));
vi.mock("@/lib/booking/event-token", () => ({ verifyEventToken: () => ({ eventId: "ev1", hash: "h1" }) }));
vi.mock("@/lib/checkout/rate-limit", () => ({ checkCheckoutRateLimit: () => ({ ok: true }), clientIpFrom: () => "ip" }));
const stripe = vi.hoisted(() => ({
  createCheckoutSessionForSubAccount: vi.fn(async (_: unknown) => ({ id: "cs_1", url: "https://stripe.test/cs_1", livemode: false })),
  getSubAccountStripe: vi.fn(async () => ({})),
  StripeConnectionError: class extends Error {},
}));
vi.mock("@/lib/stripe/sub-account-client", () => stripe);

mem.db = createMemoryFirestore();
const { POST } = await import("./route");

function seed(paymentCurrency: string, paymentAmount: number) {
  mem.db.seed("subAccounts/sa1", { paymentsEnabledByAgency: true });
  mem.db.seed("events/ev1", {
    agencyId: "ag1",
    subAccountId: "sa1",
    status: "awaiting_payment",
    publicTokenHash: "h1",
    title: "Consult",
    paymentAmount,
    paymentCurrency,
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

it("charges a JPY deposit in whole yen", async () => {
  seed("JPY", 5000);
  expect((await pay()).status).toBe(200);
  expect(unitAmount()).toBe(5000);
});

it("still charges a USD deposit in cents", async () => {
  seed("USD", 25.5);
  expect((await pay()).status).toBe(200);
  expect(unitAmount()).toBe(2550);
});
