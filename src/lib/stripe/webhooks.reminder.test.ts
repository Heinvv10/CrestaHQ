import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * publishCallback never throws — it resolves null when the 3-day Gitpage
 * reminder could not be queued. That must be logged against the checkout
 * session, not swallowed by a catch that can never fire.
 */

const publishCallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/automations/qstash", () => ({
  publishCallback,
  qstashIsConfigured: () => true,
}));
vi.mock("@/config/landing", () => ({ LANDING_VARIANT: "leadstack" }));
vi.mock("@/lib/stripe/welcome-email", () => ({ sendFoundersWelcomeEmail: async () => "msg1" }));
vi.mock("@/lib/affiliate/account", () => ({ ensureAffiliateAccount: async () => ({ code: "AFF1" }) }));
vi.mock("@/lib/affiliate/referrals", () => ({ createReferral: vi.fn() }));
vi.mock("@/lib/gitpage/agency-code", () => ({ mintGitpageAgencyCode: async () => ({ code: "GP1" }) }));
vi.mock("@/lib/gitpage/reminder-config", () => ({ REMINDER_DELAY_SECONDS: 259200 }));
vi.mock("@/lib/landing/attribution-rollup", () => ({ bumpLandingAttribution: async () => {} }));
vi.mock("@/lib/landing/buyer-map-revalidate", () => ({ revalidateBuyerMap: () => {} }));
vi.mock("@/lib/server/billing-service", () => ({
  SUB_ACCOUNT_CHARGE_KIND: "sub_account_charge",
  SUB_ACCOUNT_PLAN_KIND: "sub_account_plan",
  handleSubAccountChargeCheckoutCompleted: vi.fn(),
  handleSubAccountPlanCheckoutCompleted: vi.fn(),
  handleSubAccountSubscriptionEvent: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => {
  const ref = {
    create: async () => {},
    update: async () => {},
    set: async () => {},
    get: async () => ({ exists: false }),
  };
  return { getAdminDb: () => ({ collection: () => ({ doc: () => ref }), doc: () => ref }) };
});

const { handleCheckoutCompleted } = await import("./webhooks");

const session = {
  id: "cs_test_1",
  metadata: { kind: "founders" },
  customer_details: { email: "buyer@example.test" },
  amount_total: 9900,
  customer: "cus_1",
} as unknown as Stripe.Checkout.Session;

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  publishCallback.mockReset().mockResolvedValue({ messageId: "m1" });
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("founders checkout — 3-day reminder publish", () => {
  it("logs the session when the reminder publish resolves null", async () => {
    publishCallback.mockResolvedValue(null);
    await handleCheckoutCompleted(session);
    expect(publishCallback).toHaveBeenCalledWith(
      expect.objectContaining({ deduplicationId: "gitpage-reminder-cs_test_1" }),
    );
    expect(error).toHaveBeenCalledWith("[founders] failed to schedule 3-day reminder for cs_test_1");
  });

  it("logs nothing when the reminder is queued", async () => {
    await handleCheckoutCompleted(session);
    expect(publishCallback).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});
