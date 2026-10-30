import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

import {
  AMOUNT,
  MANDATE,
  NOW,
  REF,
  SCHEDULE,
  chargeAnswer,
  raised,
  seedCardSchedule,
  seedMandate,
  stubAutoCharge,
  tasksAbout,
} from "@/test/auto-charge-harness";
import { OTHER_KEY, SA, mem, refused, seedSub, stubPaystack, verified } from "@/test/paystack-links-harness";

/**
 * Seam test: a REAL card cycle leaves its invoice's charge pending or
 * unknown; the REAL re-check route asks Paystack (the `fetch` stub) and
 * records only what Paystack answers — paid through the same reconciler the
 * webhook uses, declined so the invoice can be sent with a pay link, or left
 * alone. The operator asserts nothing.
 */

const fireWorkflowTrigger = vi.fn();
const sendEmail = vi.fn();
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: async () => "INV-2026-0004" }));
vi.mock("@/lib/server/tasks-service", async () => (await import("@/test/auto-charge-harness")).tasksMock());
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: (...a: unknown[]) => fireWorkflowTrigger(...a) }));
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
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1" ? { uid: "u1", subAccountId } : NextResponse.json({ error: "Not a member" }, { status: 403 }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({
  territoryGateForContact: async (_a: unknown, contactId: string | null) =>
    contactId === "c-hidden" ? NextResponse.json({ error: "Outside your territory" }, { status: 403 }) : null,
}));
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-at-least-16";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

const { runOneSchedule } = await import("@/lib/server/recurring-invoice-service");
const { sendQuoteServerSide } = await import("@/lib/server/quote-send-service");
const { POST } = await import("./route");

async function recheck(quoteId = raised().id, sa = SA) {
  const res = await POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: sa, quoteId }) });
  return { status: res.status, body: (await res.json()) as { outcome?: string; error?: string } };
}
/** A card cycle whose charge call answered `status` (success → pending; send_otp → unknown). */
async function cycle(status = "success") {
  stubAutoCharge({ charge: () => chargeAnswer(status) });
  await runOneSchedule(SCHEDULE, NOW);
  expect(raised().autoCharge).toMatchObject({ state: status === "success" ? "pending" : "unknown" });
}
/** Paystack's verify answer for the re-check. */
const verifyAnswers = (answer: ReturnType<typeof verified> | ReturnType<typeof refused> | "network-error") =>
  stubPaystack(() => answer);
const send = () =>
  sendQuoteServerSide({ subAccountId: SA, quoteId: raised().id, actor: { kind: "system", reason: "test" } });
const charged = () => fireWorkflowTrigger.mock.calls.filter(([i]) => i.type === "invoice.charge_succeeded").length;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  sendEmail.mockResolvedValue(undefined);
  fireWorkflowTrigger.mockResolvedValue({ enrolled: [], skipped: [], reason: null });
  seedSub();
  seedCardSchedule();
  seedMandate();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Paystack says success", () => {
  it("records the invoice paid by the saved card, as the webhook would", async () => {
    await cycle();
    stubAutoCharge();
    expect(await recheck()).toEqual({ status: 200, body: { outcome: "paid" } });
    expect(raised()).toMatchObject({
      status: "paid",
      paidVia: { rail: "paystack_auto", mandateId: MANDATE, reference: REF },
      autoCharge: { state: "paid" },
    });
    expect(mem.read(`paymentAttempts/${REF}`)!.state).toBe("settled");
    expect(charged()).toBe(1);
  });

  it("a replayed re-check after success changes nothing", async () => {
    await cycle();
    stubAutoCharge();
    await recheck();
    const before = raised();
    expect((await recheck()).status).toBe(409);
    expect(raised()).toEqual(before);
    expect(charged()).toBe(1);
  });
});

describe("Paystack says it was not paid", () => {
  it.each([
    ["failed", verified({ reference: REF, amount: AMOUNT, status: "failed" })],
    ["abandoned", verified({ reference: REF, amount: AMOUNT, status: "abandoned" })],
    ["not found", refused(404, "Transaction reference not found")],
  ])("%s → declined, the decline counted, and the invoice then sends with a pay link", async (_label, answer) => {
    await cycle("send_otp");
    verifyAnswers(answer);
    expect(await recheck()).toEqual({ status: 200, body: { outcome: "declined" } });
    expect(raised().autoCharge).toMatchObject({ reference: REF, state: "declined" });
    expect(mem.read(`paymentAttempts/${REF}`)!.state).toBe("refused");
    expect(mem.read(`paymentMandates/${MANDATE}`)!.consecutiveDeclines).toBe(1);
    await flushAfterResponse();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    // The button records; it never emails on its own (the stale sweep does).
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await send()).toMatchObject({ ok: true });
    expect((sendEmail.mock.calls.at(-1)![0] as { text: string }).text).toContain("/pay/link/");
  });

  it("the breaker's repro: a PayPal tenant's unconfirmed charge that failed can be sent after the re-check", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, paypalConfig: { username: "acme" } });
    await cycle("send_otp");
    expect(await send()).toMatchObject({ ok: false, failure: { code: "card_charge_unsettled" } });
    verifyAnswers(verified({ reference: REF, amount: AMOUNT, status: "failed" }));
    expect((await recheck()).body.outcome).toBe("declined");
    expect(await send()).toMatchObject({ ok: true });
    expect(raised().status).toBe("sent");
  });
});

describe("no answer yet", () => {
  it.each([
    ["ongoing", verified({ reference: REF, amount: AMOUNT, status: "ongoing" })],
    ["pending", verified({ reference: REF, amount: AMOUNT, status: "pending" })],
    ["no answer", "network-error" as const],
  ])("%s → pending, nothing changed", async (_label, answer) => {
    await cycle();
    const before = raised();
    verifyAnswers(answer);
    expect(await recheck()).toEqual({ status: 200, body: { outcome: "pending" } });
    expect(raised()).toEqual(before);
    expect(mem.read(`paymentAttempts/${REF}`)!.state).toBe("open");
  });
});

describe("refusals", () => {
  it("the Paystack key changed since the charge → 409, Paystack not asked", async () => {
    await cycle();
    mem.seed(`subAccounts/${SA}/private/paystackConnection`, { secretKey: OTHER_KEY });
    const calls = stubAutoCharge();
    expect(await recheck()).toEqual({
      status: 409,
      body: { error: "The Paystack key changed since this charge; check your Paystack dashboard." },
    });
    expect(calls).toHaveLength(0);
    expect(raised().autoCharge).toMatchObject({ state: "pending" });
  });

  it.each(["declined", "paid", "needs_attention"])("an invoice whose charge is %s → 409", async (state) => {
    await cycle();
    mem.seed(`quotes/${raised().id}`, { ...raised(), autoCharge: { ...(raised().autoCharge as object), state } });
    stubAutoCharge();
    expect((await recheck()).status).toBe(409);
  });

  it("an invoice with no card charge → 409", async () => {
    await cycle();
    mem.seed(`quotes/${raised().id}`, { ...raised(), autoCharge: null });
    expect((await recheck()).status).toBe(409);
  });

  it("not a member of the sub-account → 403", async () => {
    await cycle();
    expect((await recheck(raised().id, "sa2")).status).toBe(403);
  });

  it("another sub-account's invoice → 403, nothing changed", async () => {
    await cycle();
    const { id, ...rest } = raised();
    mem.seed(`quotes/${id}`, { ...rest, subAccountId: "sa2" });
    stubAutoCharge();
    expect((await recheck(id)).status).toBe(403);
    expect(mem.read(`quotes/${id}`)!.status).not.toBe("paid");
  });

  it("a contact outside the caller's territory → 403", async () => {
    await cycle();
    mem.seed(`quotes/${raised().id}`, { ...raised(), contactId: "c-hidden" });
    stubAutoCharge();
    expect((await recheck()).status).toBe(403);
  });

  it("the unknown-outcome Task points at the re-check, never at a pay link", async () => {
    await cycle("send_otp");
    const [task] = tasksAbout(REF);
    expect(task.notes).toContain("Re-check card charge");
    expect(task.notes).toContain("Do not send a pay link");
  });
});
