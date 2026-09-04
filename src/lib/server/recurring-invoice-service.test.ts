import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The recurring-invoice run. Every guard here protects a customer from being
 * invoiced twice, invoiced after their schedule ended, or silently not
 * invoiced at all — unattended, every night, until a human notices.
 */

const NOW = new Date("2026-03-01T05:00:00.000Z");

const updates: Record<string, unknown>[] = [];
const txUpdates: Record<string, unknown>[] = [];
const written: Record<string, unknown>[] = [];
const sendQuoteServerSide = vi.fn();
const createTaskServerSide = vi.fn();
const issueQuoteNumber = vi.fn();

let schedule: Record<string, unknown> | null;
/** txUpdates.length at the moment the invoice number was issued. */
let claimedBeforeGenerate = -1;
/** Invoice ids the arrears query will return as unpaid ("sent"/"viewed"). */
let unpaidInvoiceIds: string[] = [];

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (_id?: string) => ({
        id: "inv_new",
        get: async () => ({ exists: !!schedule, data: () => schedule, id: "sch_1" }),
        set: async (data: Record<string, unknown>) => {
          written.push({ collection: name, ...data });
        },
        update: async (patch: Record<string, unknown>) => {
          updates.push(patch);
        },
      }),
      where: () => ({
        where: () => ({
          get: async () => ({
            size: unpaidInvoiceIds.length,
            docs: unpaidInvoiceIds.map((id) => ({ id })),
          }),
          orderBy: () => ({
            limit: () => ({
              get: async () => ({
                size: schedule ? 1 : 0,
                docs: schedule ? [{ id: "sch_1" }] : [],
              }),
            }),
          }),
        }),
      }),
    }),
    doc: () => ({
      get: async () => ({
        exists: true,
        data: () => ({ accountContact: { email: "ops@acme.test" } }),
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async () => ({
          exists: !!schedule,
          data: () => schedule,
          id: "sch_1",
        }),
        update: (_ref: unknown, patch: Record<string, unknown>) => {
          txUpdates.push(patch);
          // Applied to the stored schedule, not just recorded. Without this
          // the mock cannot show a SECOND run seeing the advanced state, so
          // no test could prove the redelivery guarantee.
          if (schedule) Object.assign(schedule, patch);
        },
      }),
  }),
}));
vi.mock("@/lib/quotes/number", () => ({
  issueQuoteNumber: (...a: unknown[]) => issueQuoteNumber(...a),
}));
vi.mock("@/lib/server/quote-send-service", () => ({
  sendQuoteServerSide: (...a: unknown[]) => sendQuoteServerSide(...a),
}));
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: (...a: unknown[]) => createTaskServerSide(...a),
  territoryForContact: async () => "terr_1",
}));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => "TS",
    increment: (n: number) => ({ increment: n }),
  },
  Timestamp: {
    fromDate: (d: Date) => ({ toDate: () => d, __date: d }),
  },
}));

const { runOneSchedule } = await import("./recurring-invoice-service");

/** The patch written by the claim transaction. */
function claim() {
  const c = txUpdates[0];
  if (!c) throw new Error("nothing was claimed");
  return c;
}
/** The date the claim advanced nextRunAt to. */
function nextRun(): Date {
  return (claim().nextRunAt as { __date: Date }).__date;
}
function settle() {
  const s = updates.find((u) => "outstandingInvoices" in u);
  if (!s) throw new Error("the schedule was never settled");
  return s;
}

function makeSchedule(over: Record<string, unknown> = {}) {
  return {
    id: "sch_1",
    agencyId: "ag_1",
    subAccountId: "sa_1",
    createdByUid: "u_1",
    contactId: "c_1",
    name: "Acme retainer",
    status: "active",
    currency: "zar",
    lineItems: [{ description: "Retainer", quantity: 1, unitPrice: 5000 }],
    globalDiscount: null,
    globalTaxPercent: 15,
    termsAndNotes: "Net 7",
    billedToOrganization: "Acme Pty Ltd",
    billingAddress: null,
    paymentDueDays: 7,
    cadence: { unit: "month", interval: 1 },
    anchorDay: 31,
    timezone: "Africa/Johannesburg",
    // 28 Feb local (JHB, UTC+2) — the February cycle of a 31st-anchored
    // schedule, already clamped. March must return to the 31st.
    nextRunAt: { toDate: () => new Date("2026-02-27T22:00:00.000Z") },
    endMode: "never",
    endAt: null,
    maxCycles: null,
    reviewFirst: false,
    unpaidEscalationThreshold: 2,
    cyclesGenerated: 3,
    outstandingInvoices: 0,
    lastEscalatedCount: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  txUpdates.length = 0;
  written.length = 0;
  claimedBeforeGenerate = -1;
  // The just-raised invoice is in the query result, as it would be once sent.
  unpaidInvoiceIds = ["inv_new"];
  // Records how far the claim had got when the invoice was minted, so
  // ordering can be asserted rather than assumed.
  issueQuoteNumber.mockImplementation(async () => {
    claimedBeforeGenerate = txUpdates.length;
    return "INV-2026-0004";
  });
  sendQuoteServerSide.mockResolvedValue({
    ok: true,
    sentTo: "billing@customer.test",
    paymentLinkUrl: "https://paypal.me/acme/5750ZAR",
    wasResend: false,
  });
  createTaskServerSide.mockResolvedValue({ id: "task_1" });
  schedule = makeSchedule();
});

describe("generating a cycle", () => {
  it("raises an invoice from the template and sends it", async () => {
    const outcome = await runOneSchedule("sch_1", NOW);

    expect(outcome).toMatchObject({ kind: "generated", sent: true });
    const invoice = written[0];
    expect(invoice).toMatchObject({
      collection: "quotes",
      kind: "invoice",
      status: "draft",
      subAccountId: "sa_1",
      contactId: "c_1",
      quoteNumber: "INV-2026-0004",
      currency: "zar",
      globalTaxPercent: 15,
      recurringInvoiceId: "sch_1",
    });
    expect(issueQuoteNumber).toHaveBeenCalledWith("sa_1", "invoice", NOW);
  });

  it("snapshots the line items rather than referencing the template", async () => {
    await runOneSchedule("sch_1", NOW);
    // Editing the template later must never change an invoice already raised
    // — it is a historical record of what was billed.
    expect(written[0].lineItems).toEqual(schedule!.lineItems);
  });

  it("stamps the contact's territory so the rep who owns the account can see it", async () => {
    await runOneSchedule("sch_1", NOW);
    // Without it the rules read a null territory and deny the invoice to
    // everyone but admins — including the rep whose account it is.
    expect(written[0].territoryId).toBe("terr_1");
  });

  it("sends as the system, naming the schedule as its reason", async () => {
    await runOneSchedule("sch_1", NOW);
    expect(sendQuoteServerSide).toHaveBeenCalledWith(
      expect.objectContaining({
        subAccountId: "sa_1",
        quoteId: "inv_new",
        // A customer replying to an automated invoice has to reach a human,
        // not a shared sender nobody watches.
        replyTo: "ops@acme.test",
        actor: { kind: "system", reason: "recurring invoice schedule sch_1" },
      }),
    );
  });

  it("generates a draft and sends NOTHING when reviewFirst is set", async () => {
    schedule = makeSchedule({ reviewFirst: true });
    const outcome = await runOneSchedule("sch_1", NOW);
    expect(outcome).toMatchObject({ kind: "generated", sent: false });
    expect(written[0].status).toBe("draft");
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
  });

  it("keeps the invoice when the send fails, and records why", async () => {
    sendQuoteServerSide.mockResolvedValue({
      ok: false,
      failure: { code: "email_not_configured", status: 503, error: "no Resend" },
    });
    const outcome = await runOneSchedule("sch_1", NOW);
    // The invoice is real and the operator can send it by hand; losing it
    // because email was misconfigured would be worse.
    expect(outcome).toMatchObject({ kind: "generated", sent: false });
    expect(
      updates.some((u) => String(u.lastError ?? "").includes("not sent")),
    ).toBe(true);
  });
});

describe("claiming — one invoice per cycle", () => {
  it("advances nextRunAt BEFORE the invoice is minted", async () => {
    await runOneSchedule("sch_1", NOW);
    expect(txUpdates).toHaveLength(1);
    expect(claim().nextRunAt).toBeTruthy();
    expect(claim().cyclesGenerated).toBe(4);
    // Ordering, observed rather than assumed: move the claim after the
    // generate and this is 0. Asserting only that a claim happened would let
    // the two be reordered silently — and a claim after the send is what
    // invoices a customer twice.
    expect(claimedBeforeGenerate).toBe(1);
  });

  it("generates exactly ONE invoice when the same callback is re-delivered", async () => {
    const first = await runOneSchedule("sch_1", NOW);
    const second = await runOneSchedule("sch_1", NOW);

    // QStash retries. The second delivery must find the schedule already
    // advanced and do nothing — this is the guarantee the whole claim-first
    // design exists for.
    expect(first.kind).toBe("generated");
    expect(second).toEqual({ kind: "skipped", reason: "not_due" });
    expect(written).toHaveLength(1);
    expect(sendQuoteServerSide).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a schedule that is not yet due", async () => {
    schedule = makeSchedule({
      nextRunAt: { toDate: () => new Date("2026-04-01T00:00:00.000Z") },
    });
    const outcome = await runOneSchedule("sch_1", NOW);
    expect(outcome).toEqual({ kind: "skipped", reason: "not_due" });
    expect(written).toHaveLength(0);
  });

  it("does nothing on a paused or cancelled schedule", async () => {
    for (const status of ["paused", "cancelled", "completed"]) {
      updates.length = 0;
      written.length = 0;
      schedule = makeSchedule({ status });
      const outcome = await runOneSchedule("sch_1", NOW);
      expect(outcome).toEqual({ kind: "skipped", reason: `status_${status}` });
      expect(written).toHaveLength(0);
    }
  });

  it("re-anchors the next run from the anchor, not the clamped day", async () => {
    // This schedule is anchored to the 31st and just ran its clamped 28 Feb
    // cycle. March must return to the 31st: clamping from the previous
    // cycle's day instead gives 28 Mar, and one February would cost the
    // schedule its month-end anchor permanently.
    await runOneSchedule("sch_1", NOW);
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Johannesburg",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(nextRun());
    expect(local).toBe("2026-03-31");
  });
});

describe("arrears", () => {
  it("does not count the invoice it just raised", async () => {
    unpaidInvoiceIds = ["inv_new", "inv_old"];
    await runOneSchedule("sch_1", NOW);
    // An invoice cannot be overdue on the day it is sent. Counting it made a
    // threshold of 2 fire when exactly one prior invoice was outstanding.
    expect(settle().outstandingInvoices).toBe(1);
    expect(createTaskServerSide).not.toHaveBeenCalled();
  });

  it("counts outstanding invoices from the invoices themselves", async () => {
    unpaidInvoiceIds = ["inv_new", "a", "b", "c"];
    await runOneSchedule("sch_1", NOW);
    // Counted, not incremented, so an operator marking one paid by hand is
    // picked up without a second write path and a miscount cannot accumulate.
    expect(settle().outstandingInvoices).toBe(3);
  });

  it("raises a Task once the threshold is reached", async () => {
    unpaidInvoiceIds = ["inv_new", "a", "b"];
    await runOneSchedule("sch_1", NOW);
    expect(createTaskServerSide).toHaveBeenCalledWith(
      expect.objectContaining({
        subAccountId: "sa_1",
        contactId: "c_1",
        title: expect.stringContaining("unpaid"),
      }),
    );
    expect(settle().lastEscalatedCount).toBe(2);
  });

  it("stays quiet below the threshold", async () => {
    unpaidInvoiceIds = ["inv_new", "a"];
    await runOneSchedule("sch_1", NOW);
    expect(createTaskServerSide).not.toHaveBeenCalled();
  });

  it("does not re-raise a Task while the situation is unchanged", async () => {
    schedule = makeSchedule({ lastEscalatedCount: 3 });
    unpaidInvoiceIds = ["inv_new", "a", "b", "c"];
    await runOneSchedule("sch_1", NOW);
    // A fresh Task every night — each firing task.created webhooks — is how an
    // operator learns to ignore them.
    expect(createTaskServerSide).not.toHaveBeenCalled();
  });

  it("raises another Task when it gets worse", async () => {
    schedule = makeSchedule({ lastEscalatedCount: 3 });
    unpaidInvoiceIds = ["inv_new", "a", "b", "c", "d"];
    await runOneSchedule("sch_1", NOW);
    expect(createTaskServerSide).toHaveBeenCalledTimes(1);
    expect(settle().lastEscalatedCount).toBe(4);
  });

  it("never escalates when the threshold is 0", async () => {
    unpaidInvoiceIds = ["inv_new", "a", "b", "c", "d", "e"];
    schedule = makeSchedule({ unpaidEscalationThreshold: 0 });
    await runOneSchedule("sch_1", NOW);
    expect(createTaskServerSide).not.toHaveBeenCalled();
  });

  it("still raises the invoice when the customer is in arrears", async () => {
    unpaidInvoiceIds = ["inv_new", "a", "b", "c", "d"];
    const outcome = await runOneSchedule("sch_1", NOW);
    // The debt is real. Silently ceasing to bill a slow payer is worse than
    // billing them again.
    expect(outcome.kind).toBe("generated");
    expect(sendQuoteServerSide).toHaveBeenCalled();
  });
});

describe("a schedule that is far behind", () => {
  it("fast-forwards instead of emailing a year of invoices one a night", async () => {
    schedule = makeSchedule({
      timezone: "UTC",
      anchorDay: 1,
      nextRunAt: { toDate: () => new Date("2025-04-01T00:00:00.000Z") },
    });

    const outcome = await runOneSchedule("sch_1", NOW);

    // The claim advances ONE cycle, so without this a backdated schedule
    // raises and sends a real invoice every night until it catches up.
    expect(outcome).toEqual({ kind: "skipped", reason: "too_stale" });
    expect(written).toHaveLength(0);
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
    expect(claim().nextRunAt).toBeTruthy();
    expect(String(claim().lastError)).toContain("Raise it by hand");
  });

  it("still bills a cycle only a few days late", async () => {
    schedule = makeSchedule({
      timezone: "UTC",
      anchorDay: 1,
      nextRunAt: { toDate: () => new Date("2026-02-25T00:00:00.000Z") },
    });
    const outcome = await runOneSchedule("sch_1", NOW);
    expect(outcome.kind).toBe("generated");
  });
});

describe("ending a schedule", () => {
  it("completes after the final counted cycle", async () => {
    schedule = makeSchedule({
      endMode: "after_count",
      maxCycles: 4,
      cyclesGenerated: 3,
    });
    await runOneSchedule("sch_1", NOW);
    expect(claim().status).toBe("completed");
  });

  it("keeps billing when after_count has no maxCycles, rather than stopping at one", async () => {
    // `>= (maxCycles ?? 0)` completes on the first cycle. Failing safe
    // silently is still failing: the customer stops being billed and nobody
    // is told why.
    schedule = makeSchedule({
      endMode: "after_count",
      maxCycles: null,
      cyclesGenerated: 0,
    });
    await runOneSchedule("sch_1", NOW);
    expect(written).toHaveLength(1);
    expect(claim().status).toBeUndefined();
  });

  it("keeps running while cycles remain", async () => {
    schedule = makeSchedule({
      endMode: "after_count",
      maxCycles: 6,
      cyclesGenerated: 3,
    });
    await runOneSchedule("sch_1", NOW);
    expect(claim().status).toBeUndefined();
  });

  it("completes when the next cycle would fall past the end date", async () => {
    schedule = makeSchedule({
      endMode: "on_date",
      endAt: { toDate: () => new Date("2026-03-15T00:00:00.000Z") },
    });
    await runOneSchedule("sch_1", NOW);
    // Today's invoice is still raised — the end date bounds the schedule, it
    // does not cancel a cycle already due.
    expect(written).toHaveLength(1);
    expect(claim().status).toBe("completed");
  });

  it("does not complete early when the sweep is catching up days late", async () => {
    // The cycle due 31 Jan is raised on 3 Feb, after an outage. Completion
    // must be judged from the cycle CLAIMED (next run 28 Feb, still inside
    // the agreement) — not from today, which would compute 31 Mar, decide the
    // schedule is over, and never raise the February invoice the customer
    // owes.
    schedule = makeSchedule({
      timezone: "UTC",
      anchorDay: 31,
      nextRunAt: { toDate: () => new Date("2026-01-31T00:00:00.000Z") },
      endMode: "on_date",
      endAt: { toDate: () => new Date("2026-03-10T00:00:00.000Z") },
    });

    await runOneSchedule("sch_1", new Date("2026-02-03T05:00:00.000Z"));

    expect(written).toHaveLength(1);
    expect(claim().status).toBeUndefined();
  });

  it("refuses to bill past the end after a settle failure left it active", async () => {
    // A transient throw between the claim and the settle leaves the schedule
    // active with nextRunAt already advanced. The next sweep must close it
    // rather than raise and EMAIL an invoice past the end of the agreement.
    schedule = makeSchedule({
      timezone: "UTC",
      anchorDay: 1,
      endMode: "on_date",
      endAt: { toDate: () => new Date("2026-03-15T00:00:00.000Z") },
      nextRunAt: { toDate: () => new Date("2026-04-01T00:00:00.000Z") },
    });

    const outcome = await runOneSchedule(
      "sch_1",
      new Date("2026-04-01T05:00:00.000Z"),
    );

    expect(outcome).toEqual({ kind: "skipped", reason: "already_finished" });
    expect(written).toHaveLength(0);
    expect(sendQuoteServerSide).not.toHaveBeenCalled();
    expect(claim().status).toBe("completed");
  });

  it("refuses an after_count schedule that already ran its last cycle", async () => {
    schedule = makeSchedule({
      endMode: "after_count",
      maxCycles: 4,
      cyclesGenerated: 4,
    });
    const outcome = await runOneSchedule("sch_1", NOW);
    expect(outcome).toEqual({ kind: "skipped", reason: "already_finished" });
    expect(written).toHaveLength(0);
  });

  it("keeps running when the end date is still ahead", async () => {
    schedule = makeSchedule({
      endMode: "on_date",
      endAt: { toDate: () => new Date("2027-01-01T00:00:00.000Z") },
    });
    await runOneSchedule("sch_1", NOW);
    expect(claim().status).toBeUndefined();
  });
});
