import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A card-deposit Checkout session must not outlive the booking's payment
 * hold. Stripe's default is 24 h, so a visitor could pay after expire-step
 * had already cancelled the booking and released the slot. Stripe accepts
 * `expires_at` between 30 min and 24 h out, so the hold is clamped to that.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());

const createSession = vi.fn(async (_input: { params: Record<string, unknown> }) => ({
  id: "cs_test_1",
  url: "https://checkout.stripe.test/cs_test_1",
  livemode: false,
}));
vi.mock("@/lib/stripe/sub-account-client", () => ({
  createCheckoutSessionForSubAccount: (input: { params: Record<string, unknown> }) =>
    createSession(input),
  getSubAccountStripe: async () => ({}),
  StripeConnectionError: class extends Error {},
}));
vi.mock("@/lib/server/orders-service", () => ({ createPendingOrder: async () => undefined }));

const { SA, mem, resetBookingHarness, seedEvent } = await h();
const { POST } = await import("./route");
const { issueEventToken } = await import("@/lib/booking/event-token");

const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const MIN = 60_000;

let ip = 0;
function pay(token: string) {
  return POST(
    new Request("http://x/api/events/t/pay", {
      method: "POST",
      headers: { "x-forwarded-for": `10.9.0.${++ip}` },
    }),
    { params: Promise.resolve({ token }) },
  );
}

/** An awaiting-payment booking whose hold ends `holdMinutes` from now. */
function seedHold(holdMinutes: number | null): string {
  const { token, hash } = issueEventToken("e1");
  seedEvent("e1", "10:00", "10:30", {
    status: "awaiting_payment",
    bookingPageSlug: "p",
    publicTokenHash: hash,
    paymentAmount: 50,
    paymentCurrency: "USD",
    paymentHoldExpiresAt:
      holdMinutes === null ? null : ts(new Date(Date.now() + holdMinutes * MIN)),
  });
  return token;
}
const expiresAt = () => createSession.mock.calls[0]?.[0].params.expires_at as number | undefined;
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  resetBookingHarness();
  createSession.mockClear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", paymentsEnabledByAgency: true });
});
afterEach(() => vi.useRealTimers());

describe("card deposit checkout expiry", () => {
  it("expires when the hold does", async () => {
    const token = seedHold(3 * 60);
    expect((await pay(token)).status).toBe(200);
    expect(expiresAt()).toBe(nowSec() + 3 * 60 * 60);
  });

  it("is clamped up to Stripe's 30-minute minimum when the hold ends sooner", async () => {
    const token = seedHold(10);
    expect((await pay(token)).status).toBe(200);
    const e = expiresAt()!;
    expect(e).toBeGreaterThan(nowSec() + 30 * 60);
    expect(e).toBeLessThanOrEqual(nowSec() + 32 * 60);
  });

  it("is clamped down to Stripe's 24-hour maximum for a longer hold", async () => {
    const token = seedHold(48 * 60);
    expect((await pay(token)).status).toBe(200);
    const e = expiresAt()!;
    expect(e).toBeLessThan(nowSec() + 24 * 60 * 60);
    expect(e).toBeGreaterThan(nowSec() + 23 * 60 * 60);
  });

  it("is refused once the hold has lapsed", async () => {
    const token = seedHold(-1);
    expect((await pay(token)).status).toBe(409);
    expect(createSession).not.toHaveBeenCalled();
  });
});
