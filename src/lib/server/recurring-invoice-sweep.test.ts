import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep across MANY schedules: pacing a schedule that is behind, one bad
 * schedule not blocking the rest, and a schedule whose contact is gone.
 * `recurring-invoice-service.test.ts` covers one schedule's cycle in depth;
 * this file needs a store that holds several, so it has its own mock.
 */

const NOW = new Date("2026-03-10T05:00:00.000Z");
const DAY = 86_400_000;

type Row = Record<string, unknown> & { nextRunAt: { toDate: () => Date } };
const schedules = new Map<string, Row>();
const contacts = new Set<string>();
const written: Record<string, unknown>[] = [];
const claimsAttempted: string[] = [];
let invoiceSeq = 0;
/** Thrown by the next transaction, then cleared — a one-off Firestore hiccup. */
let txError: Error | null = null;

const ts = (d: Date) => ({ toDate: () => d });

function dueSnapshots(cutoff: Date, after: string | null, limit: number) {
  const rows = [...schedules.entries()]
    .filter(([, r]) => r.status === "active" && r.nextRunAt.toDate() <= cutoff)
    .map(([id, r]) => ({ id, at: r.nextRunAt.toDate().getTime(), data: { ...r } }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
  return rows
    .slice(start, start + limit)
    .map((r) => ({ id: r.id, data: () => r.data }));
}

function dueQuery(cutoff: Date, after: string | null = null) {
  const q = {
    where: () => q,
    orderBy: () => q,
    startAfter: (doc: { id: string }) => dueQuery(cutoff, doc.id),
    limit: (n: number) => ({
      get: async () => {
        const docs = dueSnapshots(cutoff, after, n);
        return { docs, size: docs.length };
      },
    }),
  };
  return q;
}

function scheduleRef(id: string) {
  return {
    id,
    path: `recurringInvoices/${id}`,
    update: async (patch: Record<string, unknown>) => {
      Object.assign(schedules.get(id)!, patch);
    },
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === "recurringInvoices") {
        return {
          doc: (id: string) => scheduleRef(id),
          where: (_f: string, _op: string, value: unknown) =>
            _f === "nextRunAt"
              ? dueQuery((value as { toDate: () => Date }).toDate())
              : { where: (_g: string, _o: string, v: { toDate: () => Date }) => dueQuery(v.toDate()) },
        };
      }
      // quotes: invoice writes, and the arrears query (nothing unpaid).
      return {
        doc: () => {
          const id = `inv_${++invoiceSeq}`;
          return {
            id,
            set: async (data: Record<string, unknown>) => {
              written.push({ id, ...data });
            },
          };
        },
        where: () => ({ where: () => ({ get: async () => ({ size: 0, docs: [] }) }) }),
      };
    },
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: true, data: () => ({}) }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (txError) {
        const err = txError;
        txError = null;
        throw err;
      }
      return fn({
        get: async (ref: { path: string }) => {
          const [col, id] = ref.path.split("/");
          if (col === "contacts") return { exists: contacts.has(id), id };
          claimsAttempted.push(id);
          const row = schedules.get(id);
          return { exists: !!row, id, data: () => (row ? { ...row } : undefined) };
        },
        update: (ref: { path: string }, patch: Record<string, unknown>) => {
          Object.assign(schedules.get(ref.path.split("/")[1])!, patch);
        },
      });
    },
  }),
}));
vi.mock("@/lib/quotes/number", () => ({
  issueQuoteNumber: async () => `INV-${invoiceSeq + 1}`,
}));
vi.mock("@/lib/server/quote-send-service", () => ({
  sendQuoteServerSide: async () => ({ ok: true }),
}));
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: async () => ({ id: "task_1" }),
  territoryForContact: async () => "terr_1",
}));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: async () => {} }));
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "TS" },
  Timestamp: { fromDate: (d: Date) => ts(d) },
}));

const { runRecurringInvoiceSweep, runOneSchedule, RECURRING_BATCH_SIZE } =
  await import("./recurring-invoice-service");

function addSchedule(id: string, over: Record<string, unknown> = {}) {
  const row = {
    agencyId: "ag_1",
    subAccountId: "sa_1",
    createdByUid: "u_1",
    contactId: `c_${id}`,
    name: `Schedule ${id}`,
    status: "active",
    currency: "zar",
    lineItems: [{ description: "Retainer", quantity: 1, unitPrice: 100 }],
    globalDiscount: null,
    globalTaxPercent: null,
    termsAndNotes: "",
    billedToOrganization: null,
    billingAddress: null,
    paymentDueDays: 7,
    // Weekly, two cycles behind: due 10 days ago, then 3 days ago.
    cadence: { unit: "week", interval: 1 },
    anchorDay: null,
    timezone: "UTC",
    nextRunAt: ts(new Date(NOW.getTime() - 10 * DAY)),
    endMode: "never",
    endAt: null,
    maxCycles: null,
    reviewFirst: false,
    unpaidEscalationThreshold: 2,
    cyclesGenerated: 1,
    lastRunAt: null,
    lastEscalatedCount: null,
    ...over,
  } as Row;
  schedules.set(id, row);
  contacts.add(row.contactId as string);
  return row;
}

const invoicesFor = (id: string) =>
  written.filter((w) => w.recurringInvoiceId === id).length;

beforeEach(() => {
  schedules.clear();
  contacts.clear();
  written.length = 0;
  claimsAttempted.length = 0;
  invoiceSeq = 0;
  txError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a schedule more than one cycle behind", () => {
  it("raises one invoice per day, not a second on the same day's continuation", async () => {
    addSchedule("a");
    await runRecurringInvoiceSweep(NOW);
    expect(invoicesFor("a")).toBe(1);

    // The continuation (or a QStash retry) a minute later finds the schedule
    // still due — its next cycle was 3 days ago — and must leave it alone.
    await runRecurringInvoiceSweep(new Date(NOW.getTime() + 60_000));
    expect(invoicesFor("a")).toBe(1);

    // Tomorrow's sweep catches up the next cycle, as the design intends.
    await runRecurringInvoiceSweep(new Date(NOW.getTime() + DAY));
    expect(invoicesFor("a")).toBe(2);
  });

  it("refuses a second claim of the same schedule on the same day", async () => {
    addSchedule("a");
    const first = await runOneSchedule("a", NOW);
    const second = await runOneSchedule("a", new Date(NOW.getTime() + 60_000));
    expect(first.kind).toBe("generated");
    expect(second).toEqual({ kind: "skipped", reason: "ran_today" });
    expect(invoicesFor("a")).toBe(1);
  });

  it("lets the continuation reach schedules the first batch never got to", async () => {
    for (let i = 0; i <= RECURRING_BATCH_SIZE; i++) {
      addSchedule(`s${String(i).padStart(2, "0")}`);
    }
    const first = await runRecurringInvoiceSweep(NOW);
    expect(first.generated).toBe(RECURRING_BATCH_SIZE);
    expect(first.hasMore).toBe(true);

    // The 25 already billed are still due (behind), and sort first. The
    // continuation must bill only the one left over, then stop continuing.
    const second = await runRecurringInvoiceSweep(new Date(NOW.getTime() + 60_000));
    expect(second.generated).toBe(1);
    expect(second.hasMore).toBe(false);
    expect(written).toHaveLength(RECURRING_BATCH_SIZE + 1);
  });
});

describe("one broken schedule", () => {
  it("fails alone, and every schedule after it still runs", async () => {
    // Due first, so it sorts ahead of the healthy one.
    addSchedule("bad", {
      timezone: "Not/A_Zone",
      nextRunAt: ts(new Date(NOW.getTime() - 2 * DAY)),
    });
    addSchedule("good", { nextRunAt: ts(new Date(NOW.getTime() - DAY)) });

    const result = await runRecurringInvoiceSweep(NOW);

    expect(result.failed).toBe(1);
    expect(result.generated).toBe(1);
    expect(invoicesFor("good")).toBe(1);
    expect(invoicesFor("bad")).toBe(0);
    // Surfaced where the operator looks, not only in a log.
    expect(String(schedules.get("bad")!.lastError)).toMatch(/\S/);
  });

  it("is not retried by a continuation on the same day", async () => {
    addSchedule("bad", { timezone: "Not/A_Zone" });
    await runRecurringInvoiceSweep(NOW);
    claimsAttempted.length = 0;

    const again = await runRecurringInvoiceSweep(new Date(NOW.getTime() + 60_000));
    expect(claimsAttempted).toEqual([]);
    expect(again.processed).toBe(0);
    expect(again.hasMore).toBe(false);
  });
});

describe("a transient Firestore error", () => {
  it("still fails the sweep so QStash retries it the same day", async () => {
    addSchedule("a", { nextRunAt: ts(new Date(NOW.getTime() - DAY)) });
    txError = Object.assign(new Error("14 UNAVAILABLE: try again"), { code: 14 });

    await expect(runRecurringInvoiceSweep(NOW)).rejects.toThrow("UNAVAILABLE");

    // Traced — the claim may have committed — but not parked for the day.
    expect(String(schedules.get("a")!.lastError)).toContain("by hand");
    expect(schedules.get("a")!.lastFailedAt).toBeUndefined();

    // The retry reaches it and bills it.
    const retry = await runRecurringInvoiceSweep(new Date(NOW.getTime() + 60_000));
    expect(retry.generated).toBe(1);
    expect(invoicesFor("a")).toBe(1);
  });

  it("isolates an error without a retryable code", async () => {
    addSchedule("a", { nextRunAt: ts(new Date(NOW.getTime() - DAY)) });
    txError = Object.assign(new Error("bad data"), { code: 3 });
    const result = await runRecurringInvoiceSweep(NOW);
    expect(result.failed).toBe(1);
    expect(schedules.get("a")!.lastFailedAt).toBeDefined();
  });
});

describe("a schedule whose contact was deleted", () => {
  it("is paused, with the reason, instead of raising an invoice to nobody", async () => {
    addSchedule("a", { nextRunAt: ts(new Date(NOW.getTime() - DAY)) });
    contacts.clear();

    const outcome = await runOneSchedule("a", NOW);

    expect(outcome).toEqual({ kind: "skipped", reason: "contact_gone" });
    expect(written).toHaveLength(0);
    expect(schedules.get("a")!.status).toBe("paused");
    expect(String(schedules.get("a")!.lastError)).toContain("contact");
  });
});
