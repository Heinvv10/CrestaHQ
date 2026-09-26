import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { SCHEDULE } from "@/test/quote-fixtures";

/**
 * The PR11 recurring-schedule capabilities through the real dispatch and
 * decide route: every create / edit / pause / resume / cancel is a spend
 * proposal whose preview shows the schedule old -> new, the next billing and
 * whether a saved card is charged; approve writes the schedule route's own
 * update only if the stored schedule and the card, re-read in the write's
 * transaction, are what was reviewed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann", email: "ann@x.io", territoryId: "global" };
const CARD = { ...SCHEDULE, chargeMode: "card", cardMandateId: "m1" };
const MANDATE = {
  subAccountId: "sa1", recurringInvoiceId: "rs1", status: "active", attention: null,
  terms: { amountCents: 100000, currency: "ZAR", frequency: "every month", text: "terms" },
};
const NEW = { contactId: "c1", name: "Support", cadence: { unit: "month", interval: 1 }, startDateString: "2030-02-01", lineItems: [{ description: "Support", quantity: 1, unitPrice: 800 }], currency: "ZAR" };
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
async function proposeId(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
/** After approve's claim: inside execute's write transaction. */
const inWrite = (change: () => unknown) => beforeNextTransaction(async () => beforeNextTransaction(async () => { await change(); }));

beforeEach(() => {
  mem.seed("contacts/c1", ANN);
  mem.seed("recurringInvoices/rs1", SCHEDULE);
});

describe("create_recurring_schedule", () => {
  it("a spend proposal showing the whole schedule and first billing, nothing written; approve writes it", async () => {
    const id = await proposeId("create_recurring_schedule", NEW);
    expect(row(id).approval).toBe("spend");
    expect(rowOf(id, "Invoices go to")).toBe("Ann (a***@x.io)");
    expect(rowOf(id, "Amount each cycle")).toBe("ZAR 800 (ZAR)");
    expect(rowOf(id, "Frequency")).toBe("every month, on day 1 (UTC)");
    expect(rowOf(id, "Next billing")).toBe("2030-02-01");
    expect(rowOf(id, "Card")).toBe("No card is charged: each invoice is emailed.");
    expect(mem.list("recurringInvoices")).toHaveLength(1);
    expect((await decide(id, "approve")).status).toBe(200);
    const created = mem.list("recurringInvoices").find((d) => d.id !== "rs1")!;
    expect(created).toMatchObject({ subAccountId: "sa1", contactId: "c1", name: "Support", status: "active", currency: "ZAR", createdByUid: "u_admin" });
  });

  it.each([
    ["another schedule's name in capitals", { name: "RETAINER" }, "The name is the same as, or looks like, an existing one (another schedule's)."],
    ["a contact with no email", { contactId: "c_noemail" }, "That contact has no email address to send invoices to."],
    ["an end date before the first billing", { endMode: "on_date", endDateString: "2030-01-15" }, "The end date falls before the first billing date."],
  ])("%s -> refused at propose", async (_label, patch, message) => {
    mem.seed("contacts/c_noemail", { ...ANN, email: "" });
    expect(await call("create_recurring_schedule", { ...NEW, ...patch })).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("the contact's email changed after the approver's preview check -> failed, nothing written", async () => {
    const id = await proposeId("create_recurring_schedule", NEW);
    beforeNextTransaction(async () => mem.seed("contacts/c1", { ...ANN, email: "other@x.io" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The schedule, its first billing date or the contact's email changed since this was reviewed; nothing was set up.");
    expect(mem.list("recurringInvoices")).toHaveLength(1);
  });

  it("a weekly schedule starting a year ago -> refused (it would bill every missed cycle), no proposal", async () => {
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    expect(await call("create_recurring_schedule", { ...NEW, cadence: { unit: "week", interval: 1 }, startDateString: yearAgo })).toMatchObject({
      ok: false, message: "The start date is in the past, which would bill every missed cycle; pick today or later.",
    });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("a start date of today is fine", async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(await call("create_recurring_schedule", { ...NEW, startDateString: today })).toMatchObject({ ok: true, proposal: { status: "pending" } });
  });

  it.each([
    ["create", "create_recurring_schedule", NEW],
    ["update", "update_recurring_schedule", { scheduleId: "rs1" }],
  ])("%s: a line naming another sub-account's product -> refused, no proposal", async (_label, name, base) => {
    mem.seed("products/pr_other", { subAccountId: "sa2", name: "Theirs", unitPriceCents: 1, currency: "ZAR" });
    expect(await call(name, { ...base, lineItems: [{ description: "X", quantity: 1, unitPrice: 1, productId: "pr_other" }] })).toMatchObject({
      ok: false, message: "A line names a product that isn't in this workspace.",
    });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("an invisible character in the name -> invalid args", async () => {
    expect(await call("create_recurring_schedule", { ...NEW, name: "Support\u200b" })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("pause / resume / cancel / update", () => {
  it("pause: old -> new, then approve pauses it", async () => {
    const id = await proposeId("pause_recurring_schedule", { scheduleId: "rs1" });
    expect(row(id).approval).toBe("spend");
    expect(rowOf(id, "Status")).toBe("active \u2192 paused");
    expect(rowOf(id, "Card")).toBe("No card is charged: the schedule is paused.");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("recurringInvoices/rs1")!.status).toBe("paused");
  });

  it("resume_recurring_schedule -> a spend proposal naming the card that will be charged; approve resumes", async () => {
    mem.seed("recurringInvoices/rs1", { ...CARD, status: "paused" });
    mem.seed("paymentMandates/m1", MANDATE);
    const id = await proposeId("resume_recurring_schedule", { scheduleId: "rs1" });
    expect(row(id).approval).toBe("spend");
    expect(rowOf(id, "Status")).toBe("paused \u2192 active");
    expect(rowOf(id, "Card")).toBe("The saved card (m1) is charged ZAR 1,000 on the next cycle, unless Paystack refuses it (then the invoice is emailed).");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("recurringInvoices/rs1")!.status).toBe("active");
  });

  it("the saved card revoked inside the resume's write transaction -> failed, still paused", async () => {
    mem.seed("recurringInvoices/rs1", { ...CARD, status: "paused" });
    mem.seed("paymentMandates/m1", MANDATE);
    const id = await proposeId("resume_recurring_schedule", { scheduleId: "rs1" });
    inWrite(() => mem.seed("paymentMandates/m1", { ...MANDATE, status: "revoked" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The schedule or its card changed since this was reviewed; nothing was changed.");
    expect(mem.read("recurringInvoices/rs1")!.status).toBe("paused");
  });

  it("the schedule edited inside the write transaction -> failed, unchanged", async () => {
    const id = await proposeId("cancel_recurring_schedule", { scheduleId: "rs1" });
    inWrite(() => mem.seed("recurringInvoices/rs1", { ...SCHEDULE, lineItems: [{ ...SCHEDULE.lineItems[0], unitPrice: 5 }] }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("recurringInvoices/rs1")!.status).toBe("active");
  });

  it("the card's state changed after the approver's preview check -> failed before any write", async () => {
    mem.seed("recurringInvoices/rs1", CARD);
    mem.seed("paymentMandates/m1", MANDATE);
    const id = await proposeId("update_recurring_schedule", { scheduleId: "rs1", name: "Support plan" });
    beforeNextTransaction(async () => mem.seed("paymentMandates/m1", { ...MANDATE, status: "attention" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The schedule, its next billing or its card changed since this was reviewed; nothing was changed.");
    expect(mem.read("recurringInvoices/rs1")!.name).toBe("Retainer");
  });

  it("update: a new amount breaks the saved card's terms, and the preview says the invoice is emailed instead", async () => {
    mem.seed("recurringInvoices/rs1", CARD);
    mem.seed("paymentMandates/m1", MANDATE);
    const id = await proposeId("update_recurring_schedule", { scheduleId: "rs1", lineItems: [{ description: "Support", quantity: 1, unitPrice: 1200 }] });
    expect(rowOf(id, "Amount each cycle")).toBe("ZAR 1,000 (ZAR) \u2192 ZAR 1,200 (ZAR)");
    expect(rowOf(id, "Line items after")).toBe("1 \u00d7 Support @ ZAR 1,200 = ZAR 1,200");
    expect(rowOf(id, "Card")).toBe("The saved card's terms no longer match this schedule's amount or frequency: the invoice is emailed instead.");
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("recurringInvoices/rs1")!.lineItems).toEqual([{ id: "line1", description: "Support", quantity: 1, unitPrice: 1200, productId: null }]);
  });

  it.each([
    ["resuming an active schedule", "resume_recurring_schedule", {}, "That schedule is active, so it can't be resumed."],
    ["pausing a cancelled schedule", "pause_recurring_schedule", { status: "cancelled" }, "That schedule is cancelled, so it can't be paused."],
    ["resuming a cancelled schedule", "resume_recurring_schedule", { status: "cancelled" }, "That schedule is cancelled, so it can't be resumed."],
    ["editing a completed schedule", "update_recurring_schedule", { status: "completed" }, "A completed schedule can't be changed."],
    ["another sub-account's schedule", "cancel_recurring_schedule", { subAccountId: "sa2" }, "That recurring schedule isn't in this workspace."],
  ])("%s -> refused at propose", async (_label, name, patch, message) => {
    mem.seed("recurringInvoices/rs1", { ...SCHEDULE, ...patch });
    expect(await call(name, { scheduleId: "rs1", ...(name === "update_recurring_schedule" ? { name: "X" } : {}) })).toMatchObject({ ok: false, message });
  });

  it("update refuses the create-only fields", async () => {
    expect(await call("update_recurring_schedule", { scheduleId: "rs1", startDateString: "2031-01-01" })).toMatchObject({ ok: false, code: "invalid_args" });
  });
});
