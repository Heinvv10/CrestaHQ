import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOW,
  SCHEDULE,
  chargeCalls,
  raised,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
  tasksAbout,
} from "@/test/auto-charge-harness";
import { mem, seedSub } from "@/test/paystack-links-harness";

/**
 * Seam test: a card-mode schedule on a Paystack-only workspace, through the
 * REAL `runOneSchedule` → `chargeCycle` → `sendQuoteServerSide` → Paystack
 * link. Only the email transport, the lifecycle side-effects and the workflow
 * engine are stubbed.
 *
 * The first cycle has no saved card: its invoice must go out carrying the
 * card-on-file link that saves one — the expected start, so no Task. Any later
 * cycle that can't charge is emailed AND raises a Task.
 */

const sendEmail = vi.fn();
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: async () => "INV-2026-0001" }));
vi.mock("@/lib/server/tasks-service", async () => (await import("@/test/auto-charge-harness")).tasksMock());
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  sendEmail: (...a: unknown[]) => sendEmail(...a),
  tenantFrom: () => "Acme <billing@example.com>",
}));
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: async () => undefined,
  fireQuoteTrigger: async () => undefined,
  emitQuoteWebhook: async () => undefined,
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: async () => ({ enrolled: [], skipped: [], reason: null }),
}));
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

const { runOneSchedule } = await import("./recurring-invoice-service");

const emailText = () => (sendEmail.mock.calls.at(-1)![0] as { text: string }).text;
const lastError = () => mem.read(`recurringInvoices/${SCHEDULE}`)!.lastError as string;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  sendEmail.mockResolvedValue(undefined);
  seedSub(); // Paystack only: no PayPal, no Stripe.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("first card cycle, no card saved yet", () => {
  it("emails the invoice with a card-on-file link, and raises no Task", async () => {
    seedCardSchedule({ cardMandateId: null, cyclesGenerated: 0 });
    const calls = stubAutoCharge();
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });
    expect(chargeCalls(calls)).toHaveLength(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [link] = mem.list("paymentLinks");
    expect(link).toMatchObject({ invoiceId: raised().id, recurringInvoiceId: SCHEDULE, createdByUid: "u1" });
    expect(link.mandate).toMatchObject({ amountCents: 115000, currency: "ZAR" });
    expect(emailText()).toContain(`https://app.example.com/pay/link/${link.token}`);
    expect(raised()).toMatchObject({ status: "sent", paymentLinkId: link.id });
    expect(mem.list("tasks")).toHaveLength(0);
  });
});

describe("a later cycle that can't charge", () => {
  it("revoked card: emails the invoice with a card-on-file link AND raises a Task", async () => {
    seedCardSchedule();
    seedMandate({ status: "revoked" });
    const calls = stubAutoCharge();
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });
    expect(chargeCalls(calls)).toHaveLength(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mem.list("paymentLinks")[0].mandate).toBeTruthy();
    expect(tasksAbout("the saved card was removed")).toHaveLength(1);
  });

  it("a first cycle that still points at a card is not the expected start: a Task", async () => {
    seedCardSchedule({ cyclesGenerated: 0 });
    seedMandate({ status: "revoked" });
    stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    expect(tasksAbout("the saved card was removed")).toHaveLength(1);
  });

  it("a later cycle with no card at all: a Task", async () => {
    seedCardSchedule({ cardMandateId: null });
    stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    expect(tasksAbout("no card is saved")).toHaveLength(1);
  });

  it("keeps the charge reason in lastError when the fallback email fails", async () => {
    seedCardSchedule();
    seedMandate({ status: "revoked" });
    stubAutoCharge();
    sendEmail.mockRejectedValue(new Error("SMTP down"));
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: false });
    expect(lastError()).toContain("the saved card was removed");
    expect(lastError()).toContain("Also: invoice not sent: Send failed: SMTP down");
  });

  it("an invoice-mode schedule's failed send keeps today's lastError", async () => {
    seedCardSchedule({ chargeMode: "invoice", cardMandateId: null });
    sendEmail.mockRejectedValue(new Error("SMTP down"));
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: false });
    expect(lastError()).toBe("Invoice raised but not sent: Send failed: SMTP down");
  });
});
