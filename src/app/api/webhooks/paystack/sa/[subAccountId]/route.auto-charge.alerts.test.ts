import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
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
import { KEY, SA, mem, seedInvoice, seedSub } from "@/test/paystack-links-harness";

/**
 * Fix round 1 (PR #220), webhook side: money that arrives but cannot be
 * recorded against its invoice raises ONE Task — never one per redelivery —
 * and the operator can mark a card-cycle draft paid by hand (a pending or
 * unknown charge leaves the invoice a draft that was never emailed).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/paystack-links-harness")).adminMock());
vi.mock("@/lib/quotes/number", () => ({ issueQuoteNumber: async () => "INV-2026-0004" }));
vi.mock("@/lib/server/tasks-service", async () => (await import("@/test/auto-charge-harness")).tasksMock());
vi.mock("@/lib/server/quote-send-service", () => ({ sendQuoteServerSide: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: vi.fn(async () => ({})) }));
vi.mock("@/lib/quotes/lifecycle", () => ({
  recordQuoteActivity: vi.fn(async () => {}),
  fireQuoteTrigger: vi.fn(async () => {}),
  emitQuoteWebhook: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviews/request", () => ({ maybeSendReviewRequest: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) =>
    subAccountId === "sa1" ? { uid: "u1", subAccountId, subAccountRole: "admin" } : NextResponse.json({}, { status: 403 }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGateForContact: async () => null }));

const { POST } = await import("./route");
const { POST: MARK_PAID } = await import("@/app/api/sub-accounts/[id]/quotes/[quoteId]/mark-paid/route");
const { runOneSchedule } = await import("@/lib/server/recurring-invoice-service");

function deliver() {
  const body = JSON.stringify({ event: "charge.success", data: { reference: REF } });
  const signature = createHmac("sha512", KEY).update(body).digest("hex");
  return POST(
    new Request(`http://app.local/api/webhooks/paystack/sa/${SA}`, {
      method: "POST",
      headers: { "x-paystack-signature": signature },
      body,
    }),
    { params: Promise.resolve({ subAccountId: SA }) },
  );
}
const markPaid = (quoteId: string) =>
  MARK_PAID(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: SA, quoteId }) });

beforeEach(async () => {
  mem.clear();
  vi.clearAllMocks();
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

async function chargedCycle(charge = chargeAnswer("success")) {
  stubAutoCharge({ charge: () => charge });
  await runOneSchedule(SCHEDULE, NOW);
}

describe("verified money that cannot be recorded raises one Task, even on replay", () => {
  it("invoice already paid another way: refund may be owed, both payments named", async () => {
    await chargedCycle();
    const other = "pl-l9-0123456789abcdef";
    mem.seed(`quotes/${raised().id}`, { ...raised(), status: "paid", paidVia: { rail: "paystack_link", linkId: "l9", reference: other } });
    await deliver();
    await deliver();
    const tasks = tasksAbout(REF);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].notes).toMatch(/refund may be owed/);
    expect(tasks[0].notes).toContain(other);
    expect(tasks[0].contactId).toBe("c1");
  });

  it("invoice changed after the charge", async () => {
    await chargedCycle();
    mem.seed(`quotes/${raised().id}`, { ...raised(), globalTaxPercent: 0 });
    await deliver();
    await deliver();
    expect(tasksAbout(REF)).toHaveLength(1);
    expect(tasksAbout(REF)[0].notes).toMatch(/changed/);
  });

  it("invoice deleted after the charge", async () => {
    await chargedCycle();
    await mem.db.doc(`quotes/${raised().id}`).delete();
    await deliver();
    await deliver();
    expect(tasksAbout(REF)).toHaveLength(1);
    expect(tasksAbout(REF)[0].notes).toMatch(/no longer exists/);
  });

  it("a charge recorded as declined that later succeeds: one Task, even on replay", async () => {
    await chargedCycle(chargeAnswer("failed", "Declined"));
    await deliver();
    await deliver();
    expect(tasksAbout(REF)).toHaveLength(1);
    expect(tasksAbout(REF)[0].title).toMatch(/may be paid twice/);
  });

  it("a recorded charge raises none, first delivery or replay", async () => {
    await chargedCycle();
    await deliver();
    await deliver();
    expect(mem.list("tasks")).toHaveLength(0);
  });
});

describe("marking a card-cycle draft paid by hand", () => {
  it("a pending card draft can be marked paid; a late webhook then raises one refund Task", async () => {
    await chargedCycle(chargeAnswer("pending"));
    const id = raised().id;
    expect((await markPaid(id)).status).toBe(200);
    expect(raised()).toMatchObject({ status: "paid", paidVia: null });
    await deliver();
    await deliver();
    expect(tasksAbout(REF).filter((t) => /refund may be owed/.test(String(t.notes)))).toHaveLength(1);
  });

  it("a plain draft (no card charge) is still refused", async () => {
    seedInvoice("inv1", { status: "draft", recurringInvoiceId: SCHEDULE });
    expect((await markPaid("inv1")).status).toBe(409);
    expect(mem.read("quotes/inv1")).toMatchObject({ status: "draft" });
  });
});
