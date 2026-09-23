import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEvent, EventStatus } from "@/types/events";

const m = vi.hoisted(() => ({
  fireBookingTrigger: vi.fn(),
  recordBookingActivity: vi.fn(),
  emailIsConfigured: vi.fn(),
  sendEmail: vi.fn(),
  renderBookingCancelledEmail: vi.fn(),
}));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: m.fireBookingTrigger,
  recordBookingActivity: m.recordBookingActivity,
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: m.emailIsConfigured,
  sendEmail: m.sendEmail,
  tenantFrom: () => "test@example.com",
}));
vi.mock("@/lib/booking/email", () => ({
  renderBookingCancelledEmail: m.renderBookingCancelledEmail,
}));

const STATUSES: EventStatus[] = [
  "scheduled",
  "awaiting_payment",
  "completed",
  "cancelled",
  "no_show",
];

let updatedPatch: Record<string, unknown> | null;
/** When true, the contact + sub-account docs exist so a cancel email CAN send. */
let recordsExist: boolean;

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: recordsExist,
          data: () => ({ name: "Visitor", email: "visitor@example.com", subAccountId: "sa1" }),
        }),
        update: async (patch: Record<string, unknown>) => {
          updatedPatch = patch;
        },
      }),
    }),
    doc: () => ({
      get: async () => ({ exists: recordsExist, data: () => ({ name: "Biz" }) }),
    }),
  }),
}));

const { changeEventStatus, isValidStatusTransition, statusChangeError } = await import(
  "./event-status-service"
);

/** A comfortably-past instant, so completed/no_show transitions aren't
 *  refused by the "hasn't happened yet" gate unless a test says so. */
const PAST_STARTAT = { toDate: () => new Date(Date.now() - 60 * 60_000) } as never;

function event(
  status: EventStatus,
  startAt: CalendarEvent["startAt"] = PAST_STARTAT,
): CalendarEvent {
  return {
    id: "evt1",
    title: "Meeting",
    startAt,
    endAt: null,
    contactId: "c1",
    location: "",
    notes: "",
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
    status,
    bookingPageSlug: "page-a",
    createdAt: null,
    updatedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updatedPatch = null;
  recordsExist = false;
  m.emailIsConfigured.mockReturnValue(false);
  m.renderBookingCancelledEmail.mockReturnValue({ subject: "", text: "", html: "" });
});

describe("isValidStatusTransition — every from→to pair", () => {
  const expected: Record<string, boolean> = {
    "scheduled->scheduled": true,
    "scheduled->awaiting_payment": false,
    "scheduled->completed": true,
    "scheduled->cancelled": true,
    "scheduled->no_show": true,
    "awaiting_payment->scheduled": false,
    "awaiting_payment->awaiting_payment": true,
    "awaiting_payment->completed": false,
    "awaiting_payment->cancelled": true,
    "awaiting_payment->no_show": false,
    "completed->scheduled": false,
    "completed->awaiting_payment": false,
    "completed->completed": true,
    "completed->cancelled": false,
    "completed->no_show": true,
    "cancelled->scheduled": false,
    "cancelled->awaiting_payment": false,
    "cancelled->completed": false,
    "cancelled->cancelled": true,
    "cancelled->no_show": false,
    "no_show->scheduled": false,
    "no_show->awaiting_payment": false,
    "no_show->completed": true,
    "no_show->cancelled": false,
    "no_show->no_show": true,
  };

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      it(`${from} -> ${to} is ${expected[`${from}->${to}`]}`, () => {
        expect(isValidStatusTransition(from, to)).toBe(
          expected[`${from}->${to}`],
        );
      });
    }
  }
});

describe("changeEventStatus", () => {
  it("no-ops when current === next, without touching Firestore or firing anything", async () => {
    const outcome = await changeEventStatus(event("scheduled"), "scheduled");
    expect(outcome).toEqual({ ok: true, httpStatus: 200, status: "scheduled", noop: true });
    expect(updatedPatch).toBeNull();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("rejects an invalid transition with 409 and fires nothing", async () => {
    const outcome = await changeEventStatus(event("cancelled"), "scheduled");
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(409);
    expect(updatedPatch).toBeNull();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("awaiting_payment -> scheduled is rejected (mark-paid only)", async () => {
    const outcome = await changeEventStatus(event("awaiting_payment"), "scheduled");
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(409);
    expect(outcome.error).toMatch(/mark as paid/i);
  });

  it("applies a valid transition, writes the patch, and fires the matching trigger", async () => {
    const outcome = await changeEventStatus(event("scheduled"), "completed");
    expect(outcome.ok).toBe(true);
    expect(outcome.httpStatus).toBe(200);
    expect(updatedPatch?.status).toBe("completed");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1", contactId: "c1", bookingPageSlug: "page-a" }),
      "event_completed",
    );
  });

  it("cancels: stamps cancelledAt/cancelReason and fires event_cancelled", async () => {
    const outcome = await changeEventStatus(event("scheduled"), "cancelled", "no longer needed");
    expect(outcome.ok).toBe(true);
    expect(updatedPatch?.status).toBe("cancelled");
    expect(updatedPatch?.cancelReason).toBe("no longer needed");
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(expect.anything(), "event_cancelled");
  });

  it("names the refusal neutrally — no dashboard-only wording on the shared message", async () => {
    const outcome = await changeEventStatus(event("cancelled"), "completed");
    expect(outcome.error).toBe("This event was cancelled — its status can't change.");
    expect(outcome.error).not.toMatch(/operator/i);
  });
});

describe("changeEventStatus — completed/no_show require the event to have started", () => {
  const FUTURE = { toDate: () => new Date(Date.now() + 60 * 60_000) } as never;

  it.each(["completed", "no_show"] as const)(
    "refuses %s on a future-dated scheduled event, and fires nothing",
    async (next) => {
      const outcome = await changeEventStatus(event("scheduled", FUTURE), next);
      expect(outcome.ok).toBe(false);
      expect(outcome.httpStatus).toBe(409);
      expect(outcome.error).toBe("This appointment hasn't happened yet.");
      expect(updatedPatch).toBeNull();
      expect(m.fireBookingTrigger).not.toHaveBeenCalled();
    },
  );

  it("still allows cancelling a future booking — cancel never needed it to have started", async () => {
    const outcome = await changeEventStatus(event("scheduled", FUTURE), "cancelled");
    expect(outcome.ok).toBe(true);
  });

  it("allows completed/no_show once the event's time has passed", async () => {
    const outcome = await changeEventStatus(event("scheduled"), "completed"); // default PAST_STARTAT
    expect(outcome.ok).toBe(true);
    expect(updatedPatch?.status).toBe("completed");
  });

  it("refuses when startAt has no readable timestamp — never treated as past", async () => {
    const outcome = await changeEventStatus(event("scheduled", null), "no_show");
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(409);
  });
});

describe("statusChangeError — exact startAt boundary (< vs <=)", () => {
  const nowMs = 1_700_000_000_000;

  it("refuses when startAt === nowMs — not yet started at the exact instant", () => {
    const exact = { toDate: () => new Date(nowMs) } as never;
    const error = statusChangeError(event("scheduled", exact), "completed", nowMs);
    expect(error).toBe("This appointment hasn't happened yet.");
  });

  it("allows once startAt is 1ms before nowMs", () => {
    const justPast = { toDate: () => new Date(nowMs - 1) } as never;
    expect(statusChangeError(event("scheduled", justPast), "completed", nowMs)).toBeNull();
  });
});

describe("changeEventStatus — test mode", () => {
  const ts = (iso: string) => ({ toDate: () => new Date(iso) }) as never;
  function cancellable(mode: "live" | "test" | undefined): CalendarEvent {
    return {
      ...event("scheduled"),
      mode,
      startAt: ts("2020-01-01T10:00:00Z"),
      endAt: ts("2020-01-01T10:30:00Z"),
    };
  }

  beforeEach(() => {
    // Everything a cancel email needs is present, so only the mode gate
    // can stop it.
    recordsExist = true;
    m.emailIsConfigured.mockReturnValue(true);
  });

  it("control: a live event with the same fixture DOES record, trigger and email", async () => {
    const outcome = await changeEventStatus(cancellable("live"), "cancelled");
    expect(outcome.emailSent).toBe(true);
    expect(m.recordBookingActivity).toHaveBeenCalled();
    expect(m.fireBookingTrigger).toHaveBeenCalled();
    expect(m.sendEmail).toHaveBeenCalled();
  });

  it("labels a service booking's cancel email with its service and its own length", async () => {
    await changeEventStatus({ ...cancellable("live"), serviceName: "Consult" }, "cancelled");
    expect(m.renderBookingCancelledEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.objectContaining({ name: expect.stringMatching(/ \(Consult\)$/), durationMinutes: 30 }),
      }),
      "by_operator",
    );
  });

  it("an event with no mode (booking page) is live", async () => {
    const outcome = await changeEventStatus(cancellable(undefined), "cancelled");
    expect(outcome.emailSent).toBe(true);
    expect(m.fireBookingTrigger).toHaveBeenCalled();
  });

  it("a test-mode event gets the status write only: no activity, no trigger, no email", async () => {
    const outcome = await changeEventStatus(cancellable("test"), "cancelled");
    expect(outcome).toMatchObject({
      ok: true,
      httpStatus: 200,
      status: "cancelled",
      emailSent: false,
      emailSkipReason: "test_mode",
    });
    expect(updatedPatch?.status).toBe("cancelled");
    expect(m.recordBookingActivity).not.toHaveBeenCalled();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("a test-mode completed flip fires no trigger either", async () => {
    await changeEventStatus({ ...cancellable("test") }, "completed");
    expect(updatedPatch?.status).toBe("completed");
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
    expect(m.recordBookingActivity).not.toHaveBeenCalled();
  });
});
