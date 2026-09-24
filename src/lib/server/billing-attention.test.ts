import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { mem } from "@/test/paystack-links-harness";

/**
 * Owner email for flagged payments, driven through the real flag writers
 * (billing lifecycle) over the in-memory Firestore. Only the email transport,
 * the gate fan-out and outbound webhooks are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/server/feature-gates-service", () => ({
  applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const mail = vi.hoisted(() => ({
  configured: true,
  sendEmail: vi.fn(async (_m: { to: string; subject: string; text: string; html?: string }) => ({ id: "m1" })),
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => mail.configured,
  sendEmail: mail.sendEmail,
}));

const { handleSubAccountPlanCheckoutCompleted, recordSubAccountSubscriptionId } = await import(
  "./billing-lifecycle"
);

const session = (id: string) =>
  ({
    id,
    payment_status: "paid",
    customer: "CUS_1",
    subscription: "sub_1",
    amount_total: 99900,
    currency: "zar",
    metadata: { kind: "subAccountPlan", subAccountId: "sa1", planId: "plan1" },
  }) as unknown as Stripe.Checkout.Session;

function seedComped(sa: string, name = sa) {
  mem.seed(`subAccounts/${sa}`, {
    agencyId: "ag1",
    name,
    billing: { status: "comped", planId: null, stripePriceId: null, stripeCustomerId: "CUS_1" },
  });
}

beforeEach(() => {
  mem.clear();
  mail.configured = true;
  mail.sendEmail.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mem.seed("agencies/ag1", { ownerUid: "owner1" });
  mem.seed("users/owner1", { email: "owner@example.com" });
});

describe("owner email for a flagged payment", () => {
  it("is sent once, even when the provider redelivers the payment", async () => {
    seedComped("sa1");

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));
    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    expect(mem.list("billingEvents").filter((e) => e.event === "payment.flagged")).toHaveLength(1);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const sent = mail.sendEmail.mock.calls[0][0];
    expect(sent.to).toBe("owner@example.com");
    expect(sent.text).toContain("cs_comp");
    expect(mem.read("billingAttention/event-stripe-flag-cs_comp")).toMatchObject({
      agencyId: "ag1",
      subAccountId: "sa1",
      notifiedAt: expect.anything(),
    });
  });

  it("escapes the sub-account name in the HTML body", async () => {
    seedComped("sa1", `<img src=x onerror="alert(1)">`);

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    const { html } = mail.sendEmail.mock.calls[0][0];
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("is sent once for an ambiguous subscription, redelivered", async () => {
    seedComped("sa1");
    seedComped("sa2");
    for (const sa of ["sa1", "sa2"]) {
      mem.seed(`subAccounts/${sa}`, {
        ...mem.read(`subAccounts/${sa}`),
        billing: { status: "pending", stripeCustomerId: "CUS_1", stripePriceId: "PLN_pro", stripeSubscriptionId: null },
      });
    }

    await recordSubAccountSubscriptionId({ customerId: "CUS_1", subscriptionId: "SUB_X", planCode: "PLN_pro" });
    await recordSubAccountSubscriptionId({ customerId: "CUS_1", subscriptionId: "SUB_X", planCode: "PLN_pro" });

    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(mail.sendEmail.mock.calls[0][0].text).toContain("SUB_X");
  });

  it("claims nothing while email is not configured, so a later redelivery can still send", async () => {
    seedComped("sa1");
    mail.configured = false;
    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(mem.read("billingAttention/event-stripe-flag-cs_comp")).toBeUndefined();

    mail.configured = true;
    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("a failed send does not fail the flag write, and is not retried", async () => {
    seedComped("sa1");
    mail.sendEmail.mockRejectedValueOnce(new Error("provider down"));

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));
    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    expect(mem.list("billingEvents").filter((e) => e.event === "payment.flagged")).toHaveLength(1);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    expect(mem.read("billingAttention/event-stripe-flag-cs_comp")).toMatchObject({ notifyError: "provider down" });
  });
});
