import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { restoreBillingProviderAfterEach, spyBillingProvider } from "@/test/billing-provider-spies";

/**
 * The monthly usage close: freeze last month, mint ONE charge, email it,
 * remind. Real service, real billing-service, real provider selection with
 * every provider method spied (nothing reaches Stripe or Paystack), in-memory
 * Firestore. Only the mail transport is replaced, by a spy.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
const mail = vi.hoisted(() => ({ send: vi.fn(async (..._a: unknown[]) => ({})) }));
vi.mock("@/lib/comms/platform-email", () => ({
  resolvePlatformSender: async () => ({ kind: "shared" }),
  sendPlatformEmail: (...a: unknown[]) => mail.send(...a),
  noPlatformSender: () => new Error("no sender"),
}));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({ name: "Agency" }) }));

const { runUsageClose, freezeMonthForSubAccount } = await import("./usage-billing-service");
const { createUsageCharge, createChargeCheckoutSession } = await import("./billing-service");

restoreBillingProviderAfterEach();

/** 05:00 on the 1st, server-local: the daily job's first run of October. */
const NOW = new Date(2026, 9, 1, 5, 0);
const CHARGE = "usage_sa1_2026-09";
const EMAIL = "client@example.com";

const SUB = {
  agencyId: "ag1",
  name: "Client One",
  usageRebillingEnabled: true,
  usageRebillingSince: new Date(2026, 7, 1),
  usageQuotas: { emailsPerMonth: 100 },
  usageRates: { emailCents: 10 },
  billing: { currency: "zar" },
  accountContact: { email: EMAIL },
};
const AGENCY = { ownerUid: "own", usageRebillingEnabled: true, usageRebillingSince: new Date(2026, 7, 1) };

const charges = () => mem.list("billingCharges");
const queue = () => mem.list("usagePendingCharges");
const frozen = (month = "2026-09") =>
  (mem.read(`subAccounts/sa1/usage/${month}`)?.closed as Record<string, unknown> | undefined) ?? undefined;

beforeEach(() => {
  mem.clear();
  mail.send.mockClear();
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "x".repeat(32));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mem.seed("agencies/ag1", AGENCY);
  mem.seed("subAccounts/sa1", SUB);
  // 600 emails against 100 included at 10c: 500 over = 5,000c.
  mem.seed("subAccounts/sa1/usage/2026-09", { emailsSent: 600 });
});
afterEach(() => vi.unstubAllEnvs());

describe("the close creates exactly one charge", () => {
  it("freezes the month, mints the charge with its fields, emails it once", async () => {
    spyBillingProvider("stripe");
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ closed: 1, charged: 1, reminded: 0, failed: 0 });

    expect(frozen()).toMatchObject({
      totalCents: 5000,
      currency: "zar",
      chargeId: CHARGE,
      lineItems: [{ label: "Emails", amountCents: 5000, detail: "500 billable" }],
    });
    const [charge] = charges();
    expect(charges()).toHaveLength(1);
    expect(charge).toMatchObject({
      id: CHARGE,
      kind: "usage",
      usageMonth: "2026-09",
      amountCents: 5000,
      currency: "zar",
      status: "pending",
      subAccountId: "sa1",
      agencyId: "ag1",
      emailedTo: EMAIL,
    });
    expect(String(charge.payUrl)).toMatch(/^https:\/\/app\.example\.com\/pay\/charge\//);
    expect(queue()).toHaveLength(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("re-running the close creates no second charge and sends no second email", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const second = await runUsageClose(NOW);
    expect(second).toMatchObject({ closed: 0, charged: 0 });
    expect(charges()).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("two overlapping runs create one charge and send one email", async () => {
    spyBillingProvider("stripe");
    await Promise.all([runUsageClose(NOW), runUsageClose(NOW)]);
    expect(charges()).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("a charge that already exists is never overwritten by a re-queued month", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    // The client paid; then a crashed run left the month queued again.
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, status: "paid" });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(NOW);
    expect(out.charged).toBe(0);
    expect(charges()).toHaveLength(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("paid");
    expect(queue()).toHaveLength(0);
  });

  it("createUsageCharge itself: the second call reports created:false and leaves the first untouched", async () => {
    spyBillingProvider("stripe");
    const input = {
      agencyId: "ag1", subAccountId: "sa1", month: "2026-09", description: "Usage", amountCents: 5000,
      currency: "zar", lineItems: [], dueAt: new Date(2026, 9, 15), payerEmail: EMAIL,
    };
    const first = await createUsageCharge(input);
    const hash = mem.read(`billingCharges/${CHARGE}`)?.tokenHash;
    const second = await createUsageCharge({ ...input, amountCents: 9999 });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, chargeId: CHARGE });
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ amountCents: 5000, tokenHash: hash });
  });
});

describe("the invoice email is sent once", () => {
  /** A month frozen and its charge minted, but the email step not finished. */
  const midway = async (patch: Record<string, unknown>) => {
    spyBillingProvider("stripe");
    await createUsageCharge({
      agencyId: "ag1", subAccountId: "sa1", month: "2026-09", description: "Usage", amountCents: 5000,
      currency: "zar", lineItems: [], dueAt: new Date(2026, 9, 15), payerEmail: EMAIL,
    });
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, ...patch });
    mem.seed("subAccounts/sa1/usage/2026-09", {
      emailsSent: 600,
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
  };

  it("a run holding a fresh claim keeps the email: another run neither sends nor drops the entry", async () => {
    await midway({ invoiceEmailClaimedAt: new Date(NOW.getTime() - 60_000) });
    await runUsageClose(NOW);
    expect(mail.send).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(1);
  });

  it("a claim from a dead run (older than 15 minutes) is taken over", async () => {
    await midway({ invoiceEmailClaimedAt: new Date(NOW.getTime() - 16 * 60_000) });
    await runUsageClose(NOW);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBe(EMAIL);
    expect(queue()).toHaveLength(0);
  });

  it("an already-emailed charge is not emailed again and its entry is dropped", async () => {
    await midway({ emailedTo: EMAIL });
    await runUsageClose(NOW);
    expect(mail.send).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });

  it("a failed send releases the claim so tomorrow's run tries again", async () => {
    await midway({});
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBeNull();
    expect(mem.read(`billingCharges/${CHARGE}`)?.invoiceEmailClaimedAt).toBeUndefined();
    expect(queue()).toHaveLength(1);
    await runUsageClose(new Date(NOW.getTime() + 86_400_000));
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBe(EMAIL);
    expect(queue()).toHaveLength(0);
  });
});

describe("both switches are required", () => {
  it("agency master off: the month is closed as skipped, nothing queued or charged", async () => {
    spyBillingProvider("stripe");
    mem.seed("agencies/ag1", { ...AGENCY, usageRebillingEnabled: false });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ skipped: true, totalCents: 0, chargeId: null });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("client switch off (read fresh at freeze): skipped, even with the agency on", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    // The stale doc the caller holds still says on; the stored doc decides.
    const closed = await freezeMonthForSubAccount({
      sub: { ...SUB, id: "sa1" } as never,
      month: "2026-09",
    });
    expect(closed).toBe(true);
    expect(frozen()).toMatchObject({ skipped: true, chargeId: null });
    expect(queue()).toHaveLength(0);
  });

  it("a switch stamped on after the month ended does not bill that month", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: new Date(2026, 9, 1, 0, 0, 1) });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ skipped: true });
    expect(charges()).toHaveLength(0);
  });

  it("a switch turned off between the freeze and the charge withholds it", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    mem.seed("subAccounts/sa1/usage/2026-09", {
      emailsSent: 600,
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(NOW);
    expect(out.charged).toBe(0);
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(frozen()?.withheldAt).toBeDefined();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("a client with the switch on under an agency with it off is never charged", async () => {
    spyBillingProvider("stripe");
    mem.seed("agencies/ag1", { ...AGENCY, usageRebillingEnabled: undefined });
    await runUsageClose(NOW);
    expect(charges()).toHaveLength(0);
  });
});

describe("below the minimum", () => {
  it("is carried into the next month's charge, not charged", async () => {
    spyBillingProvider("stripe");
    // 30 over at 10c = 300c, under the 500c minimum.
    mem.seed("subAccounts/sa1/usage/2026-09", { emailsSent: 130 });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ totalCents: 300, carryOutCents: 300, chargeId: null });
    expect(charges()).toHaveLength(0);

    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 150 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    expect(frozen("2026-10")).toMatchObject({ totalCents: 800, carriedInCents: 300, carryOutCents: 0 });
    expect(mem.read("billingCharges/usage_sa1_2026-10")).toMatchObject({ amountCents: 800 });
  });
});

describe("the payment provider", () => {
  it("Paystack with nobody to email is refused loudly: no charge, still queued, logged every run", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(1);
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Paystack needs an email/));

    // Fixed by setting the contact: the SAME queued entry mints the charge.
    mem.seed("subAccounts/sa1", SUB);
    const retry = await runUsageClose(NOW);
    expect(retry.charged).toBe(1);
    expect(queue()).toHaveLength(0);
  });

  it("createUsageCharge refuses Paystack without a payer email before writing anything", async () => {
    const spies = spyBillingProvider("paystack");
    await expect(
      createUsageCharge({
        agencyId: "ag1", subAccountId: "sa1", month: "2026-09", description: "Usage", amountCents: 5000,
        currency: "zar", lineItems: [], dueAt: new Date(), payerEmail: null,
      }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Paystack needs an email/) });
    expect(charges()).toHaveLength(0);
    expect(spies.calls()).toBe(0);
  });

  it("with no provider configured nothing is minted and the month stays queued", async () => {
    spyBillingProvider("none");
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(1);
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(1);
  });

  it("paying goes through createOneTimeCheckout with the recipient's email (an admin when there is no contact)", async () => {
    const spies = spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    mem.seed("subAccounts/sa1/subAccountMembers/u1", {
      uid: "u1", role: "admin", status: "active", email: "admin@example.com",
    });
    mem.seed("subAccounts/sa1/subAccountMembers/own", {
      uid: "own", role: "admin", status: "active", email: "owner@agency.com",
    });
    await runUsageClose(NOW);
    expect(charges()).toHaveLength(1);

    spies.createOneTimeCheckout.mockResolvedValue({ url: "https://checkout.paystack.com/x", sessionId: "ref_1" });
    await createChargeCheckoutSession({
      chargeId: CHARGE,
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    });
    expect(spies.createOneTimeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        payerEmail: "admin@example.com",
        currency: "zar",
        amountCents: 5000,
        metadata: expect.objectContaining({ kind: "subAccountCharge", chargeId: CHARGE, subAccountId: "sa1" }),
      }),
    );
  });
});

describe("reminders", () => {
  const seedCharge = async (dueAt: Date) => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const doc = mem.read(`billingCharges/${CHARGE}`)!;
    mem.seed(`billingCharges/${CHARGE}`, { ...doc, dueAt });
    mail.send.mockClear();
  };

  it("sends the before-due reminder once, then the due and overdue notices on their days", async () => {
    await seedCharge(new Date(2026, 9, 15, 12, 0));
    const day = (d: number) => new Date(2026, 9, d, 5, 0);

    expect((await runUsageClose(day(5))).reminded).toBe(0);
    expect((await runUsageClose(day(12))).reminded).toBe(1);
    expect((await runUsageClose(day(13))).reminded).toBe(0);
    expect((await runUsageClose(day(15))).reminded).toBe(1);
    expect((await runUsageClose(day(16))).reminded).toBe(1);
    expect((await runUsageClose(day(17))).reminded).toBe(0);
    expect(mail.send).toHaveBeenCalledTimes(3);
    expect(Object.keys(mem.read(`billingCharges/${CHARGE}`)?.remindedAt as object).sort()).toEqual([
      "beforeDue", "onDue", "overdue",
    ]);
  });

  it("a paid or canceled charge gets no reminder", async () => {
    await seedCharge(new Date(2026, 9, 15, 12, 0));
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, status: "paid" });
    expect((await runUsageClose(new Date(2026, 9, 20, 5, 0))).reminded).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("a manual charge (no kind) is never reminded", async () => {
    spyBillingProvider("stripe");
    mem.seed("billingCharges/manual1", {
      subAccountId: "sa1", status: "pending", dueAt: new Date(2026, 9, 1), payUrl: "https://x", amountCents: 9900,
    });
    expect((await runUsageClose(new Date(2026, 9, 20, 5, 0))).reminded).toBe(0);
  });
});
