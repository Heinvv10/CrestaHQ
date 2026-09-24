import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { mem } from "@/test/paystack-links-harness";
import type { Order } from "@/types/orders";

/**
 * Email about flagged payments, driven through the real flag writers (billing
 * lifecycle, orders service) over the in-memory Firestore. The real
 * `emailIsConfigured` decides whether a sender exists — only the transport
 * (`sendEmail`), the gate fan-out and outbound webhooks are stubbed.
 */

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/paystack-links-harness")).adminMock(),
);
vi.mock("@/lib/server/feature-gates-service", () => ({
  applyFeatureGates: vi.fn(async () => ({ skippedMetaGates: [] })),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
type Sent = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  subAccount?: unknown;
  meter?: { subAccountId: string } | null;
};
const sendEmail = vi.hoisted(() => vi.fn(async (_m: Sent) => ({ id: "m1" })));
vi.mock("@/lib/comms/resend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/resend")>()),
  sendEmail,
}));

const { handleSubAccountPlanCheckoutCompleted, recordSubAccountSubscriptionId } = await import(
  "./billing-lifecycle"
);
const { flagOrderAttention } = await import("./orders-service");

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

const SMTP = {
  emailProvider: "smtp",
  smtpConfig: { verifiedAt: new Date(), host: "mail.example.com", fromEmail: "hello@gym.example" },
};

function seedComped(sa: string, over: Record<string, unknown> = {}) {
  mem.seed(`subAccounts/${sa}`, {
    agencyId: "ag1",
    name: sa,
    billing: { status: "comped", planId: null, stripePriceId: null, stripeCustomerId: "CUS_1" },
    ...over,
  });
}

const flagRows = () => mem.list("billingEvents").filter((e) => e.event === "payment.flagged");
const sent = () => sendEmail.mock.calls.map((c) => c[0]);
let errors: ReturnType<typeof vi.spyOn>;

function platformSender(on: boolean) {
  process.env.RESEND_API_KEY = on ? "re_test" : "";
  process.env.EMAIL_FROM = on ? "billing@example.com" : "";
}

beforeEach(() => {
  mem.clear();
  sendEmail.mockClear();
  platformSender(true);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  mem.seed("agencies/ag1", { ownerUid: "owner1" });
  mem.seed("users/owner1", { email: "owner@example.com" });
});
afterEach(() => {
  platformSender(false);
  vi.restoreAllMocks();
});

describe("plan-billing flag email (agency owner)", () => {
  it("is sent once through the shared sender, even when the provider redelivers", async () => {
    seedComped("sa1");

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));
    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    expect(flagRows()).toHaveLength(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: "owner@example.com" });
    expect(sent()[0].subAccount).toBeUndefined();
    expect(sent()[0].text).toContain("cs_comp");
    expect(mem.read("billingAttention/event-stripe-flag-cs_comp")).toMatchObject({
      agencyId: "ag1",
      subAccountId: "sa1",
      notifiedAt: expect.anything(),
    });
  });

  it("without a shared sender, goes through the flagged sub-account's SMTP", async () => {
    platformSender(false);
    seedComped("sa1", SMTP);

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: "owner@example.com", meter: { subAccountId: "sa1" } });
    expect(sent()[0].subAccount).toMatchObject({ emailProvider: "smtp" });
  });

  it("with no sender at all, logs it and claims nothing — so a later redelivery can still send", async () => {
    platformSender(false);
    seedComped("sa1");

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    expect(flagRows()).toHaveLength(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.read("billingAttention/event-stripe-flag-cs_comp")).toBeUndefined();
    expect(errors.mock.calls.flat().join(" ")).toMatch(/no email sender/);

    platformSender(true);
    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));
    expect(sent()).toHaveLength(1);
  });

  it("escapes the sub-account name in the HTML body", async () => {
    seedComped("sa1", { name: `<img src=x onerror="alert(1)">` });

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    const { html } = sent()[0];
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("an ambiguous subscription is emailed once, via a candidate's SMTP when there is no shared sender", async () => {
    platformSender(false);
    const pending = { status: "pending", stripeCustomerId: "CUS_1", stripePriceId: "PLN_pro", stripeSubscriptionId: null };
    seedComped("sa1", { billing: pending });
    seedComped("sa2", { billing: pending, ...SMTP });

    await recordSubAccountSubscriptionId({ customerId: "CUS_1", subscriptionId: "SUB_X", planCode: "PLN_pro" });
    await recordSubAccountSubscriptionId({ customerId: "CUS_1", subscriptionId: "SUB_X", planCode: "PLN_pro" });

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: "owner@example.com", meter: { subAccountId: "sa2" } });
    expect(sent()[0].text).toContain("SUB_X");
  });

  it("a failed send does not fail the flag write, and is not retried", async () => {
    seedComped("sa1");
    sendEmail.mockRejectedValueOnce(new Error("provider down"));

    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));
    await handleSubAccountPlanCheckoutCompleted(session("cs_comp"));

    expect(flagRows()).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(String(mem.read("billingAttention/event-stripe-flag-cs_comp")?.notifyError)).toContain("provider down");
  });
});

describe("order flag email (sub-account admins)", () => {
  const order = { id: "o1", agencyId: "ag1", subAccountId: "sa1", source: "quote", totalCents: 115000, currency: "zar", stripePaymentIntentId: "pi_1", stripeCheckoutSessionId: "cs_1" } as Order;

  beforeEach(() => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Gym" });
    mem.seed("orders/o1", { ...order });
  });

  it("goes to the sub-account's active admins, not collaborators or removed admins", async () => {
    mem.seed("subAccounts/sa1/subAccountMembers/a1", { role: "admin", status: "active", email: "admin@gym.example" });
    mem.seed("subAccounts/sa1/subAccountMembers/a2", { role: "admin", status: "removed", email: "gone@gym.example" });
    mem.seed("subAccounts/sa1/subAccountMembers/c1", { role: "collaborator", status: "active", email: "collab@gym.example" });

    await flagOrderAttention(order, "Paid, but the invoice was already paid");

    expect(sent().map((m) => m.to)).toEqual(["admin@gym.example"]);
    expect(sent()[0].text).toContain("Reports → Payments");
  });

  it("falls back to the agency owner when the sub-account has no admin", async () => {
    await flagOrderAttention(order, "Paid, but the invoice was already paid");
    expect(sent().map((m) => m.to)).toEqual(["owner@example.com"]);
  });

  it("is one flag across redeliveries even when the note's wording changes", async () => {
    await flagOrderAttention(order, "Paid, but the booking was no longer awaiting payment (canceled)");
    await flagOrderAttention(order, "Paid, but the booking was no longer awaiting payment (completed)");

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mem.read("orders/o1")).toMatchObject({ attentionOpen: true, attention: expect.stringContaining("completed") });
  });

  it("a redelivery does not reopen a flag an admin resolved", async () => {
    await flagOrderAttention(order, "note");
    mem.seed("orders/o1", { ...mem.read("orders/o1"), attentionOpen: false, attentionResolvedAt: new Date() });

    await flagOrderAttention(order, "note");

    expect(mem.read("orders/o1")).toMatchObject({ attentionOpen: false });
  });
});
