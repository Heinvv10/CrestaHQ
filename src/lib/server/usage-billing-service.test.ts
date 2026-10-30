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
const { verifyChargeToken } = await import("@/lib/billing/token");
const { flushAfterResponse } = await import("@/lib/server/after-response");
const { createUsageCharge, createChargeCheckoutSession, listChargesForSubAccount } = await import("./billing-service");

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

/** The pay link in each email sent so far (the system email's button). */
const payUrlsSent = () =>
  mail.send.mock.calls.map((c) => String(((c[1] as { text: string }).text.match(/https:\/\/\S+\/pay\/charge\/\S+/) ?? [""])[0]));
const events = async (event: string) => {
  await flushAfterResponse();
  return mem.list("billingEvents").filter((e) => e.event === event);
};
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
    expect(queue()).toHaveLength(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("stores no raw pay token: the emailed link is minted for the email and only its hash is kept", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const doc = mem.read(`billingCharges/${CHARGE}`)!;
    expect(doc.payUrl).toBeUndefined();
    const url = payUrlsSent()[0];
    expect(url).toMatch(/^https:\/\/app\.example\.com\/pay\/charge\/usage_sa1_2026-09\./);
    const token = url.split("/pay/charge/")[1];
    expect(verifyChargeToken(token)?.hash).toBe(doc.tokenHash);
    expect(JSON.stringify(doc)).not.toContain(token);
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

  it.each([
    ["client enabled mid-month", { sub: new Date(2026, 8, 10) }, "client_switched_on_after_month_start"],
    ["agency enabled mid-month", { agency: new Date(2026, 8, 10) }, "agency_switched_on_after_month_start"],
    ["client enabled one second after the month began", { sub: new Date(2026, 8, 1, 0, 0, 1) }, "client_switched_on_after_month_start"],
    ["client enabled after the month ended", { sub: new Date(2026, 9, 1, 0, 0, 1) }, "client_switched_on_after_month_start"],
    ["client since unparseable", { sub: "last tuesday" }, "client_switched_on_after_month_start"],
    ["client since missing with the switch on", { sub: undefined }, "client_switched_on_after_month_start"],
    ["agency since unparseable", { agency: { seconds: 1 } }, "agency_switched_on_after_month_start"],
    ["agency since missing with the switch on", { agency: undefined }, "agency_switched_on_after_month_start"],
  ])("%s: the month is not billed (first full month onward)", async (_label, since, reason) => {
    spyBillingProvider("stripe");
    if ("sub" in since) mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: since.sub });
    if ("agency" in since) mem.seed("agencies/ag1", { ...AGENCY, usageRebillingSince: since.agency });
    await runUsageClose(NOW);
    expect(frozen()).toMatchObject({ skipped: true, skippedReason: reason });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
  });

  it("a switch on exactly at the month's first instant bills that month", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: new Date(2026, 8, 1, 0, 0, 0, 0) });
    await runUsageClose(NOW);
    expect(charges()).toHaveLength(1);
  });

  it("a client enabled mid-month is billed from its first FULL month", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingSince: new Date(2026, 9, 10) });
    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 600 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    expect(frozen("2026-10")).toMatchObject({ skipped: true });
    await freezeMonthForSubAccount({ sub: { ...SUB, id: "sa1" } as never, month: "2026-11" });
    expect(frozen("2026-11")).not.toHaveProperty("skipped");
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

describe("a switch turned off after the freeze", () => {
  /** The month is frozen and queued, then a client switch goes off. */
  const frozenThenOff = async (setup?: () => Promise<void>) => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW); // freeze + charge + invoice email
    mem.seed("usagePendingCharges/" + CHARGE, { subAccountId: "sa1", month: "2026-09" });
    await setup?.();
    mail.send.mockClear();
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
  };
  const unsent = (extra: Record<string, unknown> = {}) => {
    const d = mem.read(`billingCharges/${CHARGE}`)!;
    mem.seed(`billingCharges/${CHARGE}`, { ...d, emailedTo: null, invoiceEmailClaimedAt: undefined, ...extra });
  };
  const DUE = new Date(2026, 9, 15, 12, 0);
  const day = (d: number) => new Date(2026, 9, d, 5, 0);

  it("a charge minted but never emailed is cancelled, the month is withheld, and no reminder follows", async () => {
    await frozenThenOff(async () => {
      unsent({ dueAt: DUE });
    });
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(0);
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "canceled", tokenHash: null });
    expect(frozen()?.withheldAt).toBeDefined();
    expect(queue()).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
    for (const d of [12, 15, 16, 20]) await runUsageClose(day(d));
    expect(mail.send).not.toHaveBeenCalled();
    expect((await events("charge.canceled")).map((e) => e.detail)).toEqual([
      expect.objectContaining({ chargeId: CHARGE, reason: "rebilling_switched_off_before_invoice" }),
    ]);
    expect(await events("usage.withheld")).toEqual([
      expect.objectContaining({ detail: { month: "2026-09", chargeId: CHARGE, chargeCanceled: true } }),
    ]);
  });

  it("once the invoice was emailed the debt stands: nothing is cancelled and reminders continue", async () => {
    await frozenThenOff(async () => {
      const d = mem.read(`billingCharges/${CHARGE}`)!;
      mem.seed(`billingCharges/${CHARGE}`, { ...d, dueAt: DUE });
    });
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "pending", emailedTo: EMAIL });
    expect(frozen()?.withheldAt).toBeUndefined();
    expect(queue()).toHaveLength(0);
    expect((await runUsageClose(day(12))).reminded).toBe(1);
    expect((await runUsageClose(day(16))).reminded).toBe(1);
  });

  it("an email being sent right now is not cancelled under it", async () => {
    await frozenThenOff(async () => {
      unsent({ invoiceEmailClaimedAt: new Date(NOW.getTime() - 60_000) });
    });
    await runUsageClose(NOW);
    expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
    expect(queue()).toHaveLength(1);
    expect(frozen()?.withheldAt).toBeUndefined();
  });

  it("a withheld month stays unbilled on every re-run", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, usageRebillingEnabled: false });
    mem.seed("subAccounts/sa1/usage/2026-09", {
      emailsSent: 600,
      closed: { totalCents: 5000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    await runUsageClose(NOW);
    // Even switched back on, the withheld month is not re-queued or billed.
    mem.seed("subAccounts/sa1", SUB);
    const again = await runUsageClose(new Date(2026, 9, 2, 5, 0));
    expect(again).toMatchObject({ closed: 0, charged: 0 });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe("reminders only for an invoice that went out", () => {
  const DUE = new Date(2026, 9, 15, 12, 0);
  const setup = async (patch: Record<string, unknown>) => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, dueAt: DUE, ...patch });
    mail.send.mockClear();
  };

  it("a charge never emailed gets no reminder, though the workspace has a recipient", async () => {
    // Pending and unsent, and no longer queued (e.g. past the invoice retry window).
    await setup({ emailedTo: null });
    expect((await runUsageClose(new Date(2026, 9, 16, 5, 0))).reminded).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("a cancelled charge gets no reminder", async () => {
    await setup({ status: "canceled" });
    expect((await runUsageClose(new Date(2026, 9, 16, 5, 0))).reminded).toBe(0);
  });

  it("each reminder carries a freshly minted link that replaces the last", async () => {
    await setup({});
    const before = mem.read(`billingCharges/${CHARGE}`)?.tokenHash;
    await runUsageClose(new Date(2026, 9, 12, 5, 0));
    const url = payUrlsSent()[0];
    const after = mem.read(`billingCharges/${CHARGE}`)?.tokenHash;
    expect(after).not.toBe(before);
    expect(verifyChargeToken(url.split("/pay/charge/")[1])?.hash).toBe(after);
  });

  it("a failed reminder send gives the stage back so tomorrow retries", async () => {
    await setup({});
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    expect((await runUsageClose(new Date(2026, 9, 12, 5, 0))).reminded).toBe(0);
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
    expect((await runUsageClose(new Date(2026, 9, 13, 5, 0))).reminded).toBe(1);
  });
});

describe("serialising a usage charge", () => {
  it("the charge list returns kind, usageMonth and dueAt (and a manual charge is still manual)", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed("billingCharges/m1", {
      id: "m1", agencyId: "ag1", subAccountId: "sa1", description: "Web design", amountCents: 9900,
      currency: "zar", status: "pending",
    });
    const list = await listChargesForSubAccount("ag1", "sa1");
    expect(list.find((c) => c.id === CHARGE)).toMatchObject({
      kind: "usage",
      usageMonth: "2026-09",
      dueAt: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
    });
    expect(list.find((c) => c.id === "m1")).toMatchObject({ kind: "manual", usageMonth: null, dueAt: null });
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

  const member = (uid: string, over: Record<string, unknown> = {}) =>
    mem.seed(`subAccounts/sa1/subAccountMembers/${uid}`, {
      uid, role: "admin", status: "active", email: `${uid}@example.com`, addedAt: new Date(2026, 0, 1), ...over,
    });

  it("paying goes through createOneTimeCheckout with the recipient: the earliest client admin, never agency staff", async () => {
    const spies = spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    member("late", { addedAt: new Date(2026, 5, 1) });
    member("first", { addedAt: new Date(2026, 1, 1) });
    member("own", { addedAt: new Date(2025, 0, 1) }); // the agency owner
    member("staff", { addedAt: new Date(2025, 0, 2) }); // agency user, earlier than both
    mem.seed("agencies/ag1/agencyMembers/staff", { uid: "staff", role: "admin", status: "active" });
    member("removed", { status: "removed", addedAt: new Date(2025, 0, 3) });
    member("collab", { role: "collaborator", addedAt: new Date(2025, 0, 4) });
    await runUsageClose(NOW);
    expect(charges()).toHaveLength(1);
    expect(mail.send.mock.calls[0][1]).toMatchObject({ to: "first@example.com" });

    spies.createOneTimeCheckout.mockResolvedValue({ url: "https://checkout.paystack.com/x", sessionId: "ref_1" });
    await createChargeCheckoutSession({
      chargeId: CHARGE,
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    });
    expect(spies.createOneTimeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        payerEmail: "first@example.com",
        currency: "zar",
        amountCents: 5000,
        metadata: expect.objectContaining({ kind: "subAccountCharge", chargeId: CHARGE, subAccountId: "sa1" }),
      }),
    );
  });

  it("the account contact beats any admin, and equal join times break on uid", async () => {
    spyBillingProvider("paystack");
    member("b"); member("a");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    await runUsageClose(NOW);
    expect(mail.send.mock.calls[0][1]).toMatchObject({ to: "a@example.com" });
    mail.send.mockClear(); mem.clear();
    mem.seed("agencies/ag1", AGENCY); mem.seed("subAccounts/sa1", SUB); member("a");
    mem.seed("subAccounts/sa1/usage/2026-09", { emailsSent: 600 });
    await runUsageClose(NOW);
    expect(mail.send.mock.calls[0][1]).toMatchObject({ to: EMAIL });
  });

  it("an admin whose join time can't be read makes the choice undeterminable: refused, nothing minted", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    member("a"); member("b", { addedAt: undefined });
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(1);
    expect(charges()).toHaveLength(0);
  });

  it("a MANUAL charge keeps the account contact exactly as before: no fallback to an admin", async () => {
    const spies = spyBillingProvider("paystack");
    spies.createOneTimeCheckout.mockResolvedValue({ url: "https://checkout.paystack.com/x", sessionId: "r" });
    member("first");
    const manual = (id: string) => ({
      id, agencyId: "ag1", subAccountId: "sa1", description: "Web design", amountCents: 9900,
      currency: "zar", status: "pending", tokenHash: "h",
    });
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    mem.seed("billingCharges/m1", manual("m1"));
    const pay = (chargeId: string) =>
      createChargeCheckoutSession({ chargeId, successUrl: "https://a/ok", cancelUrl: "https://a/no" });
    await pay("m1");
    expect(spies.createOneTimeCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ payerEmail: null }));

    mem.seed("subAccounts/sa1", { ...SUB, accountContact: { email: "contact@example.com" } });
    await pay("m1");
    expect(spies.createOneTimeCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({ payerEmail: "contact@example.com" }),
    );
  });

  it("Stripe never reaches the members lookup, usage charge or not", async () => {
    const spies = spyBillingProvider("stripe");
    spies.createOneTimeCheckout.mockResolvedValue({ url: "https://checkout.stripe.com/x", sessionId: "cs" });
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    member("first");
    await runUsageClose(NOW);
    await createChargeCheckoutSession({ chargeId: CHARGE, successUrl: "https://a/ok", cancelUrl: "https://a/no" });
    expect(spies.createOneTimeCheckout).toHaveBeenCalledWith(expect.objectContaining({ payerEmail: null }));
  });
});

describe("a charge that cannot be created", () => {
  it("over the ceiling: no charge, the month is held with a logged reason, retried each run", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 100_000_001, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(1);
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/charge held sa=sa1 month=2026-09: amountCents must be/));
    expect((await runUsageClose(NOW)).failed).toBe(1);
  });

  it("the ceiling itself is accepted", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {
      closed: { totalCents: 100_000_000, currency: "zar", lineItems: [], chargeId: CHARGE, carryOutCents: 0 },
    });
    mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
    expect((await runUsageClose(NOW)).charged).toBe(1);
  });
});

describe("nobody to email", () => {
  it("Stripe: the charge exists, the entry stays queued, and a contact set later gets the invoice", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    const first = await runUsageClose(NOW);
    expect(first).toMatchObject({ charged: 1, failed: 0 });
    expect(mail.send).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(1);
    expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ emailedTo: null, tokenHash: null });
    expect(mem.read(`billingCharges/${CHARGE}`)?.invoiceEmailClaimedAt).toBeUndefined();

    mem.seed("subAccounts/sa1", SUB);
    const second = await runUsageClose(new Date(NOW.getTime() + 86_400_000));
    expect(second.charged).toBe(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBe(EMAIL);
    expect(queue()).toHaveLength(0);
    expect(charges()).toHaveLength(1);
  });

  it("a reminder with no recipient does not use up its stage", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const doc = mem.read(`billingCharges/${CHARGE}`)!;
    mem.seed(`billingCharges/${CHARGE}`, { ...doc, dueAt: new Date(2026, 9, 15, 12, 0) });
    mail.send.mockClear();
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    expect((await runUsageClose(new Date(2026, 9, 12, 5, 0))).reminded).toBe(0);
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
    mem.seed("subAccounts/sa1", SUB);
    expect((await runUsageClose(new Date(2026, 9, 13, 5, 0))).reminded).toBe(1);
  });
});

describe("carry-over", () => {
  const closedAug = (over: Record<string, unknown>) =>
    mem.seed("subAccounts/sa1/usage/2026-08", {
      closed: { totalCents: 300, currency: "zar", lineItems: [], chargeId: null, carryOutCents: 300, ...over },
    });
  /** Close October (usage 130 emails = 300c) at 1 November. */
  const closeOctober = async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1/usage/2026-09", {});
    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 150 });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    return frozen("2026-10");
  };

  it("steps over a gap: a carry two months back is applied", async () => {
    closedAug({});
    expect(await closeOctober()).toMatchObject({ carriedInCents: 300, totalCents: 800 });
  });

  it("a carry three months back is NOT applied, and says so", async () => {
    mem.seed("subAccounts/sa1/usage/2026-07", {
      closed: { totalCents: 300, currency: "zar", lineItems: [], chargeId: null, carryOutCents: 300 },
    });
    expect(await closeOctober()).toMatchObject({ carriedInCents: 0, totalCents: 500 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/carry of 300 not applied sa=sa1 month=2026-10: it is from 2026-07/));
    // Still on record on the old month.
    expect((mem.read("subAccounts/sa1/usage/2026-07")?.closed as { carryOutCents: number }).carryOutCents).toBe(300);
  });

  it("a carry in another currency is not applied, is logged, and stays on its ledger", async () => {
    closedAug({ currency: "usd" });
    expect(await closeOctober()).toMatchObject({ carriedInCents: 0, totalCents: 500 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/carry of 300 not applied .* currency usd is not zar/));
    expect((mem.read("subAccounts/sa1/usage/2026-08")?.closed as { carryOutCents: number }).carryOutCents).toBe(300);
  });
});

describe("audit trail", () => {
  it("writes a billingEvents row for a freeze, a skip and the charge", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    expect(await events("usage.frozen")).toEqual([
      expect.objectContaining({ subAccountId: "sa1", agencyId: "ag1", detail: expect.objectContaining({ month: "2026-09", totalCents: 5000, chargeId: CHARGE }) }),
    ]);
    expect(await events("charge.created")).toHaveLength(1);

    mem.seed("subAccounts/sa1/usage/2026-10", { emailsSent: 600 });
    mem.seed("agencies/ag1", { ...AGENCY, usageRebillingEnabled: false });
    await runUsageClose(new Date(2026, 10, 1, 5, 0));
    expect(await events("usage.skipped")).toEqual([
      expect.objectContaining({ detail: { month: "2026-10", reason: "agency_off" } }),
    ]);
  });

  it("a re-run writes no second freeze row", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    await runUsageClose(NOW);
    expect(await events("usage.frozen")).toHaveLength(1);
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
