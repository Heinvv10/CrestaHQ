import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fireBookingTrigger: vi.fn(),
  recordBookingActivity: vi.fn(),
  scheduleEventReminders: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: m.fireBookingTrigger,
  recordBookingActivity: m.recordBookingActivity,
  scheduleEventReminders: m.scheduleEventReminders,
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => false,
  sendEmail: m.sendEmail,
  tenantFrom: () => "test@example.com",
}));
vi.mock("@/lib/booking/email", () => ({
  renderBookingConfirmationEmail: () => ({ subject: "Confirmed: x", text: "", html: "" }),
}));
vi.mock("@/lib/booking/ics", () => ({ generateIcs: () => "" }));
vi.mock("@/lib/booking/event-token", () => ({
  issueEventToken: (eventId: string) => ({ token: `tok_${eventId}`, hash: `hash_${eventId}` }),
  buildEventPublicUrl: (token: string) => `https://example.com/e/${token}`,
}));

let eventDoc: Record<string, unknown> | undefined;
const txnUpdates: { path: string; patch: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({ id, path: `${name}/${id}` }),
    }),
    doc: () => ({ get: async () => ({ exists: false }) }),
    runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => {
      const txn = {
        get: async () => ({
          exists: eventDoc !== undefined,
          data: () => eventDoc,
        }),
        update: (ref: { path: string }, patch: Record<string, unknown>) => {
          txnUpdates.push({ path: ref.path, patch });
        },
      };
      return fn(txn);
    },
  }),
}));

const {
  rescheduleWithoutAvailabilityCheck,
  RescheduleRejected,
  runRescheduleSideEffects,
} = await import("./reschedule");

beforeEach(() => {
  vi.clearAllMocks();
  txnUpdates.length = 0;
  eventDoc = {
    id: "evt1",
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: "c1",
    source: "booking_page",
    bookingPageSlug: "page-a",
    status: "scheduled",
    title: "Meeting",
  };
});

describe("rescheduleWithoutAvailabilityCheck", () => {
  const newStart = new Date("2030-01-01T10:00:00Z");
  const newEnd = new Date("2030-01-01T10:30:00Z");

  it("rejects a missing event with 404", async () => {
    eventDoc = undefined;
    await expect(
      rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("rejects a manual (non-booking-page) event with 400", async () => {
    eventDoc!.source = "manual";
    await expect(
      rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it.each(["cancelled", "completed", "no_show"])(
    "rejects a %s booking with 409",
    async (status) => {
      eventDoc!.status = status;
      await expect(
        rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd),
      ).rejects.toBeInstanceOf(RescheduleRejected);
      await expect(
        rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd),
      ).rejects.toMatchObject({ httpStatus: 409 });
    },
  );

  it.each(["scheduled", "awaiting_payment"])(
    "writes startAt/endAt + reschedule bookkeeping for a %s booking-page event",
    async (status) => {
      eventDoc!.status = status;
      const result = await rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd);
      expect(result.newToken).toBe("tok_evt1");
      expect(result.event.publicTokenHash).toBe("hash_evt1");
      expect(txnUpdates).toHaveLength(1);
      const { patch } = txnUpdates[0];
      expect(patch.startAt).toBe(newStart);
      expect(patch.endAt).toBe(newEnd);
      expect(patch.publicTokenHash).toBe("hash_evt1");
      expect(patch).toHaveProperty("rescheduledAt");
      expect(patch).toHaveProperty("rescheduleCount");
    },
  );
});

describe("runRescheduleSideEffects", () => {
  const args = {
    event: {
      id: "evt1",
      title: "Meeting",
      agencyId: "ag1",
      subAccountId: "sa1",
      contactId: "c1",
      bookingPageSlug: "page-a",
      status: "scheduled" as const,
    },
    page: undefined,
    newRawToken: "tok_evt1",
    publicEventUrl: "https://example.com/e/tok_evt1",
    startAt: new Date("2030-01-01T10:00:00Z"),
    endAt: new Date("2030-01-01T10:30:00Z"),
  };

  it("records the activity, tags it with the actor, and fires booking.rescheduled", async () => {
    await runRescheduleSideEffects({ ...args, actor: "operator" } as never);
    expect(m.recordBookingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1", contactId: "c1" }),
      "booking_rescheduled",
      { extra: "by operator" },
    );
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1", bookingPageSlug: "page-a" }),
      "event_rescheduled",
    );
  });

  it("does not annotate the visitor's own reschedule", async () => {
    await runRescheduleSideEffects({ ...args, actor: "visitor" } as never);
    expect(m.recordBookingActivity).toHaveBeenCalledWith(
      expect.anything(),
      "booking_rescheduled",
      { extra: null },
    );
  });

  it("skips reminders when the page has them disabled", async () => {
    await runRescheduleSideEffects({
      ...args,
      page: { remindersEnabled: false } as never,
      actor: "api",
    } as never);
    expect(m.scheduleEventReminders).not.toHaveBeenCalled();
  });

  it("re-schedules reminders with a fresh nonce when enabled", async () => {
    await runRescheduleSideEffects({
      ...args,
      page: { remindersEnabled: true, reminderOffsetsMinutes: [60] } as never,
      actor: "api",
    } as never);
    expect(m.scheduleEventReminders).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt1", rawToken: "tok_evt1" }),
    );
  });

  it("no-ops the activity/trigger/email for an event with no contact", async () => {
    await runRescheduleSideEffects({
      ...args,
      event: { ...args.event, contactId: null },
      actor: "api",
    } as never);
    expect(m.recordBookingActivity).not.toHaveBeenCalled();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });
});
