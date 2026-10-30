import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, EMAIL, NOW, SUB, events, frozen, mail, mem, payUrlsSent, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * Reminders, and invoices or reminders that cannot go out (the working link is never lost). Real service, real billing-service, real provider selection with
 * every provider method spied (nothing reaches Stripe or Paystack), in-memory
 * Firestore; only the mail transport is replaced, by a spy. Shared setup:
 * src/test/usage-billing-harness.ts.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/comms/platform-email", () => ({
  resolvePlatformSender: async () => mail.sender,
  sendPlatformEmail: (...a: unknown[]) => mail.send(...a),
  noPlatformSender: () => new Error("no sender"),
}));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({ name: "Agency" }) }));

const { runUsageClose } = await import("./usage-billing-service");
const { verifyChargeToken } = await import("@/lib/billing/token");

setupUsageBillingTests();

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

  it("a reminder that can't build a link (app URL unset) is a refusal, not a failure, and keeps its stage", async () => {
    await setup({});
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const out = await runUsageClose(new Date(2026, 9, 12, 5, 0));
    expect(out).toMatchObject({ failed: 0, reminded: 0, refusals: [{ subAccountId: "sa1", month: "2026-09" }] });
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
  });

  it("a failed reminder send gives the stage back so tomorrow retries", async () => {
    await setup({});
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    expect((await runUsageClose(new Date(2026, 9, 12, 5, 0))).reminded).toBe(0);
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
    expect((await runUsageClose(new Date(2026, 9, 13, 5, 0))).reminded).toBe(1);
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

describe("an invoice or reminder that cannot go out is reported, and never costs the working link", () => {
  const hashOf = (url: string) => verifyChargeToken(url.split("/pay/charge/")[1])?.hash;
  const DUE = new Date(2026, 9, 15, 12, 0);
  const emailedWithDue = async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, dueAt: DUE });
    const invoiceUrl = payUrlsSent()[0];
    mail.send.mockClear();
    return invoiceUrl;
  };

  it("a reminder whose send fails leaves the invoice link verifying", async () => {
    const invoiceUrl = await emailedWithDue();
    const live = mem.read(`billingCharges/${CHARGE}`)?.tokenHash;
    expect(hashOf(invoiceUrl)).toBe(live);
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    const out = await runUsageClose(new Date(2026, 9, 12, 5, 0));
    expect(out.refusals).toEqual([expect.objectContaining({ reason: "the reminder email could not be sent" })]);
    expect(mem.read(`billingCharges/${CHARGE}`)?.tokenHash).toBe(live);
    expect(hashOf(invoiceUrl)).toBe(mem.read(`billingCharges/${CHARGE}`)?.tokenHash);
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
  });

  it("a reminder with no sender stages nothing: the invoice link still verifies, and it is reported", async () => {
    const invoiceUrl = await emailedWithDue();
    mail.sender = null;
    const out = await runUsageClose(new Date(2026, 9, 12, 5, 0));
    expect(out).toMatchObject({ failed: 0, reminded: 0, refusals: [{ reason: "no email sender is configured for this workspace" }] });
    expect(hashOf(invoiceUrl)).toBe(mem.read(`billingCharges/${CHARGE}`)?.tokenHash);
    expect(mem.read(`billingCharges/${CHARGE}`)?.remindedAt).toEqual({});
    mail.sender = { kind: "shared" };
    expect((await runUsageClose(new Date(2026, 9, 13, 5, 0))).reminded).toBe(1);
  });

  it("a reminder that does go out makes its new link live and retires the old one", async () => {
    const invoiceUrl = await emailedWithDue();
    await runUsageClose(new Date(2026, 9, 12, 5, 0));
    const reminderUrl = payUrlsSent()[0];
    expect(hashOf(reminderUrl)).toBe(mem.read(`billingCharges/${CHARGE}`)?.tokenHash);
    expect(hashOf(invoiceUrl)).not.toBe(hashOf(reminderUrl));
  });

  it("an invoice send that fails is reported, clears the attempt marker, and tries again tomorrow", async () => {
    spyBillingProvider("stripe");
    mail.send.mockRejectedValueOnce(new Error("smtp down"));
    const out = await runUsageClose(NOW);
    expect(out).toMatchObject({ failed: 0, refusals: [{ reason: "the invoice email could not be sent" }] });
    const c = mem.read(`billingCharges/${CHARGE}`)!;
    expect(c.emailedTo).toBeNull();
    expect(c.emailAttemptedAt).toBeUndefined();
    expect(c.tokenHash).toBeNull();
    expect(queue()).toHaveLength(1);
    expect((await runUsageClose(new Date(NOW.getTime() + 86_400_000))).refusals).toEqual([]);
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailedTo).toBe(EMAIL);
  });

  it("the attempt marker is on the charge BEFORE the invoice is handed to the mailer", async () => {
    spyBillingProvider("stripe");
    let during: unknown = "unset";
    mail.send.mockImplementationOnce(async () => {
      during = mem.read(`billingCharges/${CHARGE}`)?.emailAttemptedAt;
      return {};
    });
    await runUsageClose(NOW);
    expect(during).toBeDefined();
    expect(during).not.toBe("unset");
    // Kept after a successful send: it did go out.
    expect(mem.read(`billingCharges/${CHARGE}`)?.emailAttemptedAt).toBeDefined();
  });

  it("an invoice with no sender is reported and stages no link", async () => {
    spyBillingProvider("stripe");
    mail.sender = null;
    const out = await runUsageClose(NOW);
    expect(out.refusals).toEqual([expect.objectContaining({ reason: "no email sender is configured for this workspace" })]);
    expect(mem.read(`billingCharges/${CHARGE}`)?.tokenHash).toBeNull();
    expect(queue()).toHaveLength(1);
  });

  describe("after 7 days with no invoice sent", () => {
    const LATER = () => new Date(Date.now() + 8 * 86_400_000);

    it("the charge is cancelled, the month withheld with a reason, an audit row written, and it is reported once", async () => {
      spyBillingProvider("stripe");
      mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
      await runUsageClose(NOW);
      expect(queue()).toHaveLength(1);

      const out = await runUsageClose(LATER());
      expect(out).toMatchObject({ failed: 0, refusals: [{ reason: expect.stringMatching(/^invoice could not be sent within 7 days/) }] });
      expect(mem.read(`billingCharges/${CHARGE}`)).toMatchObject({ status: "canceled", tokenHash: null });
      expect(frozen()).toMatchObject({ withheldReason: "invoice could not be sent" });
      expect(frozen()?.withheldAt).toBeDefined();
      expect(queue()).toHaveLength(0);
      expect(await events("usage.withheld")).toEqual([
        expect.objectContaining({ detail: expect.objectContaining({ reason: "invoice could not be sent", chargeCanceled: true }) }),
      ]);
      expect(await events("charge.canceled")).toHaveLength(1);
      expect((await runUsageClose(LATER())).refusals).toEqual([]);
    });

    it("a send that was ATTEMPTED may have gone out: the charge stands and is not cancelled", async () => {
      spyBillingProvider("stripe");
      await runUsageClose(NOW);
      mem.seed(`billingCharges/${CHARGE}`, {
        ...mem.read(`billingCharges/${CHARGE}`)!, emailedTo: null, invoiceEmailClaimedAt: undefined,
        emailAttemptedAt: new Date(),
      });
      mem.seed(`usagePendingCharges/${CHARGE}`, { subAccountId: "sa1", month: "2026-09" });
      await runUsageClose(LATER());
      expect(mem.read(`billingCharges/${CHARGE}`)?.status).toBe("pending");
      expect(frozen()?.withheldAt).toBeUndefined();
      expect(queue()).toHaveLength(0);
    });
  });
});
