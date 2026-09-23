import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOW,
  chargeAnswer,
  SCHEDULE,
  chargeCalls,
  raised,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
  tasksAbout,
} from "@/test/auto-charge-harness";
import { SA, mem, seedSub } from "@/test/paystack-links-harness";

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
const sub = (over: Record<string, unknown>) => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, ...over });
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

describe("first card cycle whose card-on-file link can't be made", () => {
  it("falls through to a plain Paystack link and raises a Task naming why", async () => {
    seedCardSchedule({ cardMandateId: null, cyclesGenerated: 0 });
    sub({ name: "" });
    stubAutoCharge();
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });
    const [link] = mem.list("paymentLinks");
    expect(link.mandate).toBeUndefined();
    expect(emailText()).toContain(`/pay/link/${link.token}`);
    const tasks = tasksAbout("Card-on-file link could not be made");
    expect(tasks).toHaveLength(1);
    expect(`${tasks[0].title} ${tasks[0].notes}`).toContain("business name");
  });
});

describe("N2 + N3: one Task per cycle, naming the real cause", () => {
  it("a revoked card AND a card-on-file link that can't be made: ONE Task carrying both", async () => {
    seedCardSchedule();
    seedMandate({ status: "revoked" });
    sub({ name: "" });
    stubAutoCharge();
    await runOneSchedule(SCHEDULE, NOW);
    const tasks = mem.list("tasks");
    expect(tasks).toHaveLength(1);
    expect(`${tasks[0].title} ${tasks[0].notes}`).toContain("the saved card was removed");
    expect(`${tasks[0].title} ${tasks[0].notes}`).toContain("business name");
  });

  it.each([
    ["Paystack is not connected", () => mem.seed(`subAccounts/${SA}/private/paystackConnection`, {})],
    ["Payments is off", () => sub({ paymentsEnabledByAgency: false })],
    ["not in ZAR", () => mem.seed(`recurringInvoices/${SCHEDULE}`, { ...mem.read(`recurringInvoices/${SCHEDULE}`)!, currency: "USD" })],
  ])("first cycle, Paystack not ready (%s), sent by PayPal: a Task and lastError name it", async (cause, breakIt) => {
    seedCardSchedule({ cardMandateId: null, cyclesGenerated: 0 });
    sub({ paypalConfig: { username: "acme" } });
    breakIt();
    stubAutoCharge();
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });
    expect(raised().paymentLinkUrl).toMatch(/^https:\/\/paypal\.me\//);
    const tasks = mem.list("tasks");
    expect(tasks).toHaveLength(1);
    expect(`${tasks[0].title} ${tasks[0].notes}`).toContain(cause);
    expect(lastError()).toContain(cause);
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

  it("a declined card: the invoice (autoCharge declined) is still emailed with a pay link", async () => {
    seedCardSchedule();
    seedMandate();
    stubAutoCharge({ charge: () => chargeAnswer("failed", "Insufficient Funds") });
    expect(await runOneSchedule(SCHEDULE, NOW)).toMatchObject({ kind: "generated", sent: true });
    expect(raised().autoCharge).toMatchObject({ state: "declined" });
    expect(emailText()).toContain(`/pay/link/${mem.list("paymentLinks")[0].token}`);
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
