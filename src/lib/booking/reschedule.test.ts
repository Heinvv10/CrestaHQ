import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fireBookingTrigger: vi.fn(),
  recordBookingActivity: vi.fn(),
  scheduleEventReminders: vi.fn(),
  sendEmail: vi.fn(),
  emailIsConfigured: vi.fn(),
  renderBookingConfirmationEmail: vi.fn(),
}));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: m.fireBookingTrigger,
  recordBookingActivity: m.recordBookingActivity,
  scheduleEventReminders: m.scheduleEventReminders,
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: m.emailIsConfigured,
  sendEmail: m.sendEmail,
  tenantFrom: () => "test@example.com",
}));
vi.mock("@/lib/booking/email", () => ({
  renderBookingConfirmationEmail: m.renderBookingConfirmationEmail,
}));
vi.mock("@/lib/booking/ics", () => ({ generateIcs: () => "", nextIcsSequence: () => 2 }));
vi.mock("@/lib/booking/event-token", () => ({
  issueEventToken: (eventId: string) => ({ token: `tok_${eventId}`, hash: `hash_${eventId}` }),
  buildEventPublicUrl: (token: string) => `https://example.com/e/${token}`,
}));

let eventDoc: Record<string, unknown> | undefined;
let pageDoc: Record<string, unknown> | undefined;
let contactDoc: Record<string, unknown> | undefined;
let subDoc: Record<string, unknown> | undefined;
const txnUpdates: { path: string; patch: Record<string, unknown> }[] = [];

// Path-keyed fake: a doc exists only when its fixture is set, so a read of
// the wrong path (or a deleted booking page) is visible to the code.
function snap(path: string) {
  const d = (
    {
      "events/evt1": eventDoc,
      "subAccounts/sa1/bookingPages/page-a": pageDoc,
      "contacts/c1": contactDoc,
      "subAccounts/sa1": subDoc,
    } as Record<string, Record<string, unknown> | undefined>
  )[path];
  return { exists: d !== undefined, data: () => d };
}
function ref(path: string) {
  return { id: path.split("/").pop(), path, get: async () => snap(path) };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    doc: (path: string) => ref(path),
    runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => {
      const txn = {
        get: async (r: { path: string }) => snap(r.path),
        update: (r: { path: string }, patch: Record<string, unknown>) => {
          txnUpdates.push({ path: r.path, patch });
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
  m.emailIsConfigured.mockReturnValue(false);
  m.renderBookingConfirmationEmail.mockReturnValue({ subject: "Confirmed: x", text: "", html: "" });
  pageDoc = { name: "Intro call", remindersEnabled: false };
  contactDoc = { name: "Visitor", email: "visitor@example.com" };
  subDoc = { name: "Biz" };
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

  it("returns the event with its path id even when the doc stores no `id` field", async () => {
    delete eventDoc!.id;
    const result = await rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd);
    expect(result.event.id).toBe("evt1");
  });

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
      expect(result.page).toEqual(pageDoc);
    },
  );

  it("refuses with 409 when the booking page was deleted — nothing written, token not rotated", async () => {
    pageDoc = undefined;
    await expect(
      rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(txnUpdates).toHaveLength(0);
  });

  it("refuses with 409 when the event has no booking page slug", async () => {
    eventDoc!.bookingPageSlug = null;
    await expect(
      rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(txnUpdates).toHaveLength(0);
  });

  it("refuses an unchanged time with 400 no_change — nothing stamped or rotated", async () => {
    eventDoc!.startAt = { toDate: () => new Date(newStart) };
    eventDoc!.endAt = { toDate: () => new Date(newEnd) };
    await expect(
      rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd),
    ).rejects.toMatchObject({ httpStatus: 400, code: "no_change" });
    expect(txnUpdates).toHaveLength(0);
  });

  it("still moves the booking when only the end changes", async () => {
    eventDoc!.startAt = { toDate: () => new Date(newStart) };
    eventDoc!.endAt = { toDate: () => new Date("2030-01-01T11:00:00Z") };
    await rescheduleWithoutAvailabilityCheck("evt1", newStart, newEnd);
    expect(txnUpdates).toHaveLength(1);
  });
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
      actor: "operator",
    } as never);
    expect(m.scheduleEventReminders).not.toHaveBeenCalled();
  });

  it("re-schedules reminders with a fresh nonce when enabled", async () => {
    await runRescheduleSideEffects({
      ...args,
      page: { remindersEnabled: true, reminderOffsetsMinutes: [60] } as never,
      actor: "operator",
    } as never);
    expect(m.scheduleEventReminders).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt1", rawToken: "tok_evt1" }),
    );
  });

  it("no-ops the activity/trigger/email for an event with no contact", async () => {
    await runRescheduleSideEffects({
      ...args,
      event: { ...args.event, contactId: null },
      actor: "operator",
    } as never);
    expect(m.recordBookingActivity).not.toHaveBeenCalled();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  describe("the visitor's \"Updated:\" email — reported, since their old link is dead", () => {
    beforeEach(() => {
      m.emailIsConfigured.mockReturnValue(true);
    });

    it("sends when email is configured and the contact has an address", async () => {
      const out = await runRescheduleSideEffects({ ...args, actor: "operator" } as never);
      expect(out).toEqual({ emailSent: true });
      expect(m.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "visitor@example.com",
          subject: expect.stringMatching(/^Updated: /),
        }),
      );
    });

    it.each([
      ["email_not_configured", () => m.emailIsConfigured.mockReturnValue(false)],
      ["no_contact_email", () => { contactDoc = { name: "Visitor", email: "" }; }],
      ["contact_opted_out", () => { contactDoc = { name: "V", email: "v@example.com", emailOptedOut: true }; }],
      ["missing_records", () => { contactDoc = undefined; }],
      ["send_failed", () => m.sendEmail.mockRejectedValueOnce(new Error("smtp down"))],
    ] as const)("reports %s", async (reason, arrange) => {
      arrange();
      const out = await runRescheduleSideEffects({ ...args, actor: "operator" } as never);
      expect(out).toEqual({ emailSent: false, emailSkipReason: reason });
    });

    it("labels a service booking with its service and its own length", async () => {
      await runRescheduleSideEffects({
        ...args,
        event: { ...args.event, serviceName: "Consult" },
        page: { name: "Intro call", durationMinutes: 15 } as never,
        endAt: new Date("2030-01-01T11:00:00Z"),
        actor: "operator",
      } as never);
      expect(m.renderBookingConfirmationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          page: expect.objectContaining({ name: "Intro call (Consult)", durationMinutes: 60 }),
        }),
      );
    });

    it("reports no_contact for an event with no linked contact", async () => {
      const out = await runRescheduleSideEffects({
        ...args,
        event: { ...args.event, contactId: null },
        actor: "operator",
      } as never);
      expect(out).toEqual({ emailSent: false, emailSkipReason: "no_contact" });
      expect(m.sendEmail).not.toHaveBeenCalled();
    });
  });
});
