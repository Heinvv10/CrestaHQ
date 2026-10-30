import { describe, expect, it, vi } from "vitest";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import { CHARGE, EMAIL, NOW, SUB, AGENCY, charges, mail, mem, payUrlsSent, queue, setupUsageBillingTests } from "@/test/usage-billing-harness";

/**
 * Pay links and recipients: staging, transactional writes, the payment provider, non-string emails. Real service, real billing-service, real provider selection with
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
const { createUsageCharge, createChargeCheckoutSession, mintChargeCheckoutLink, stageChargeLink, commitChargeLink } = await import("./billing-service");

setupUsageBillingTests();

describe("pay links", () => {
  it("rotation updates the live link: after an agency re-send the reminder carries a newer link, and neither earlier link still verifies", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const invoiceUrl = payUrlsSent()[0];
    const hashOf = (url: string) => verifyChargeToken(url.split("/pay/charge/")[1])?.hash;
    expect(hashOf(invoiceUrl)).toBe(mem.read(`billingCharges/${CHARGE}`)?.tokenHash);

    const resent = await mintChargeCheckoutLink({ agencyId: "ag1", chargeId: CHARGE });
    expect(hashOf(resent)).toBe(mem.read(`billingCharges/${CHARGE}`)?.tokenHash);
    expect(hashOf(invoiceUrl)).not.toBe(mem.read(`billingCharges/${CHARGE}`)?.tokenHash);

    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, dueAt: new Date(2026, 9, 15, 12, 0) });
    await runUsageClose(new Date(2026, 9, 12, 5, 0));
    const reminderUrl = payUrlsSent()[1];
    expect(hashOf(reminderUrl)).toBe(mem.read(`billingCharges/${CHARGE}`)?.tokenHash);
    for (const old of [invoiceUrl, resent]) expect(hashOf(old)).not.toBe(hashOf(reminderUrl));
  });
});

describe("pay-link writes refuse a charge that is no longer payable", () => {
  it("a re-send on a paid or cancelled charge throws and leaves the token alone", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    for (const status of ["paid", "canceled"]) {
      mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, status, tokenHash: null });
      await expect(mintChargeCheckoutLink({ agencyId: "ag1", chargeId: CHARGE })).rejects.toMatchObject({ status: 400 });
      expect(mem.read(`billingCharges/${CHARGE}`)?.tokenHash).toBeNull();
    }
  });

  it("another agency's charge is not found", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    await expect(mintChargeCheckoutLink({ agencyId: "other", chargeId: CHARGE })).rejects.toMatchObject({ status: 404 });
  });

  it("a link staged before the client paid is not made live afterwards", async () => {
    spyBillingProvider("stripe");
    await runUsageClose(NOW);
    const staged = stageChargeLink(CHARGE);
    mem.seed(`billingCharges/${CHARGE}`, { ...mem.read(`billingCharges/${CHARGE}`)!, status: "paid", tokenHash: null });
    await expect(commitChargeLink(CHARGE, staged.hash)).rejects.toMatchObject({ status: 400 });
    expect(mem.read(`billingCharges/${CHARGE}`)?.tokenHash).toBeNull();
  });
});

describe("a recipient that is not a string", () => {
  it("is treated as absent: no crash, the next real address is used", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: { email: 12345 } });
    mem.seed("subAccounts/sa1/subAccountMembers/bad", {
      uid: "bad", role: "admin", status: "active", email: { x: 1 }, addedAt: new Date(2026, 0, 1),
    });
    mem.seed("subAccounts/sa1/subAccountMembers/nouid", { role: "admin", status: "active", email: "nouid@example.com" });
    mem.seed("subAccounts/sa1/subAccountMembers/ok", {
      uid: "ok", role: "admin", status: "active", email: " ok@example.com ", addedAt: new Date(2026, 5, 1),
    });
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(0);
    expect(mail.send.mock.calls[0][1]).toMatchObject({ to: "ok@example.com" });
  });

  it("with nothing usable the close holds the entry instead of throwing (Stripe)", async () => {
    spyBillingProvider("stripe");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: { email: 7 } });
    const out = await runUsageClose(NOW);
    expect(out.failed).toBe(0);
    expect(queue()).toHaveLength(1);
  });
});

describe("the payment provider", () => {
  it("Paystack with nobody to email is refused loudly: no charge, still queued, logged every run", async () => {
    spyBillingProvider("paystack");
    mem.seed("subAccounts/sa1", { ...SUB, accountContact: null });
    const out = await runUsageClose(NOW);
    // A permanent refusal: reported, not a failure (the job must not answer 500).
    expect(out).toMatchObject({ failed: 0, refusals: [{ subAccountId: "sa1", month: "2026-09", reason: expect.stringMatching(/Paystack needs an email/) }] });
    expect(charges()).toHaveLength(0);
    expect(queue()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/held, needs a fix sa=sa1 month=2026-09: Paystack needs an email/));

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
    expect(out).toMatchObject({ failed: 0, refusals: [expect.objectContaining({ subAccountId: "sa1" })] });
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
    expect(out).toMatchObject({ failed: 0, refusals: [expect.objectContaining({ subAccountId: "sa1" })] });
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
