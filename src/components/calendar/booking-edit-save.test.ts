import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventFormData } from "@/types/events";

import {
  changedFields,
  saveBookingPageEdit,
  type ConfirmedTime,
  type RescheduleResponse,
  type TimeBaseline,
} from "./booking-edit-save";

const ORIG: TimeBaseline = {
  startAt: new Date("2030-01-01T10:00:00Z"),
  endAt: new Date("2030-01-01T10:30:00Z"),
};
const MOVED = {
  startAt: new Date("2030-01-01T12:00:00Z"),
  endAt: new Date("2030-01-01T12:30:00Z"),
};
type Fields = Partial<Omit<EventFormData, "startAt" | "endAt">>;
const fields: Fields = { title: "Renamed", contactId: null, location: "", notes: "", meetingUrl: null };

const reschedule = vi.fn<(id: string, s: Date, e: Date) => Promise<RescheduleResponse>>();
const updateFields = vi.fn<(id: string, f: Fields) => Promise<void>>();
const onRescheduled = vi.fn<(time: ConfirmedTime) => void>();

function save(baseline: TimeBaseline, times = MOVED, timeLocked = false) {
  return saveBookingPageEdit({
    eventId: "evt1",
    baseline,
    ...times,
    timeLocked,
    fields,
    reschedule,
    updateFields,
    onRescheduled,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  reschedule.mockResolvedValue({ ok: true, body: { notifyEmailSent: true } });
  updateFields.mockResolvedValue();
});

describe("saveBookingPageEdit", () => {
  it("reschedules FIRST and saves nothing when the reschedule is refused", async () => {
    reschedule.mockResolvedValue({ ok: false, body: { error: "Page gone" } });
    const out = await save(ORIG);
    expect(out).toEqual({ kind: "reschedule_refused", error: "Page gone" });
    expect(updateFields).not.toHaveBeenCalled();
  });

  it("doesn't call reschedule when the time is unchanged", async () => {
    const out = await save(ORIG, { startAt: ORIG.startAt!, endAt: ORIG.endAt! });
    expect(reschedule).not.toHaveBeenCalled();
    expect(out.kind).toBe("saved");
  });

  it("doesn't call reschedule when the time is locked", async () => {
    await save(ORIG, MOVED, true);
    expect(reschedule).not.toHaveBeenCalled();
    expect(updateFields).toHaveBeenCalled();
  });

  it("reports the reschedule warning when the visitor wasn't emailed", async () => {
    reschedule.mockResolvedValue({
      ok: true,
      body: { notifyEmailSent: false, notifyEmailSkipReason: "contact_opted_out" },
    });
    const out = await save(ORIG);
    expect(out.kind).toBe("saved");
    expect(out.kind === "saved" && out.warning).toMatch(
      /wasn't emailed \(the visitor opted out of email\); their old manage link no longer works/,
    );
  });

  it("reschedule OK + field write fails → keeps the warning; a retry with the returned baseline saves the fields without re-POSTing", async () => {
    reschedule.mockResolvedValue({
      ok: true,
      body: { notifyEmailSent: false, notifyEmailSkipReason: "no_contact_email" },
    });
    updateFields.mockRejectedValueOnce(new Error("offline"));
    const first = await save(ORIG);
    expect(first).toMatchObject({ kind: "fields_failed", rescheduled: true });
    expect(first.kind === "fields_failed" && first.warning).toMatch(/wasn't emailed/);
    expect(first.kind === "fields_failed" && first.baseline).toEqual(MOVED);

    // The dialog keeps the returned baseline; the retry is the same click.
    const retry = await save(first.kind === "fields_failed" ? first.baseline : ORIG);
    expect(retry.kind).toBe("saved");
    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(updateFields).toHaveBeenCalledTimes(2);
  });

  it("hands over the times the server's 200 confirmed, not the ones asked for, before the field write", async () => {
    reschedule.mockResolvedValue({
      ok: true,
      body: { notifyEmailSent: true, newStartAt: "2030-01-01T13:00:00.000Z", newEndAt: "2030-01-01T13:30:00.000Z" },
    });
    // The field write never settles (it waits on a silent Listen stream).
    updateFields.mockReturnValue(new Promise(() => {}));
    void save(ORIG);
    await vi.waitFor(() => expect(updateFields).toHaveBeenCalled());
    expect(onRescheduled.mock.calls).toEqual([
      [{ startAt: new Date("2030-01-01T13:00:00Z"), endAt: new Date("2030-01-01T13:30:00Z") }],
    ]);
    expect(onRescheduled.mock.invocationCallOrder[0]).toBeLessThan(updateFields.mock.invocationCallOrder[0]);
  });

  it("hands over the reschedule count the 200 stored, with the times", async () => {
    reschedule.mockResolvedValue({
      ok: true,
      body: {
        notifyEmailSent: true,
        newStartAt: MOVED.startAt.toISOString(),
        newEndAt: MOVED.endAt.toISOString(),
        rescheduleCount: 3,
      },
    });
    await save(ORIG);
    expect(onRescheduled.mock.calls).toEqual([[{ ...MOVED, rescheduleCount: 3 }]]);
  });

  it("confirms no time when the response carries none", async () => {
    expect((await save(ORIG)).kind).toBe("saved"); // 200, but no newStartAt / newEndAt in the body
    expect(onRescheduled).not.toHaveBeenCalled();
  });

  it("confirms no time when the reschedule is refused or was not needed", async () => {
    const body = { newStartAt: MOVED.startAt.toISOString(), newEndAt: MOVED.endAt.toISOString() };
    reschedule.mockResolvedValue({ ok: false, body: { ...body, error: "Page gone" } });
    expect((await save(ORIG)).kind).toBe("reschedule_refused");
    reschedule.mockResolvedValue({ ok: false, body: { ...body, code: "no_change" } });
    expect((await save(ORIG)).kind).toBe("saved");
    reschedule.mockResolvedValue({ ok: true, body });
    await save(ORIG, { startAt: ORIG.startAt!, endAt: ORIG.endAt! });
    await save(ORIG, MOVED, true);
    expect(onRescheduled).not.toHaveBeenCalled();
  });

  it("treats a server no_change as 'time already applied' and still saves the fields", async () => {
    reschedule.mockResolvedValue({
      ok: false,
      body: { error: "That's already the booking's time.", code: "no_change" },
    });
    const out = await save(ORIG);
    expect(out).toEqual({ kind: "saved", baseline: MOVED, warning: null });
    expect(updateFields).toHaveBeenCalledWith("evt1", fields);
  });
});

describe("an edit with nothing but the time changed", () => {
  it("moves the booking and writes no fields", async () => {
    const out = await saveBookingPageEdit({
      eventId: "evt1",
      baseline: ORIG,
      ...MOVED,
      timeLocked: false,
      fields: {},
      reschedule,
      updateFields,
    });
    expect(out.kind).toBe("saved");
    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(updateFields).not.toHaveBeenCalled();
  });
});

describe("changedFields", () => {
  const base: EventFormData = {
    title: "Intro",
    startAt: new Date("2030-01-01T09:00:00Z"),
    endAt: new Date("2030-01-01T09:30:00Z"),
    contactId: "c1",
    location: "",
    notes: "",
    meetingUrl: null,
  };

  it("is empty when nothing changed (times compared by value)", () => {
    expect(changedFields({ ...base, startAt: new Date(base.startAt), endAt: new Date(base.endAt) }, base)).toEqual({});
  });
  it("holds only the fields that changed: an unchanged contact is left out, so no contact read", () => {
    expect(changedFields({ ...base, notes: "Bring ID" }, base)).toEqual({ notes: "Bring ID" });
    expect(changedFields({ ...base, contactId: null, meetingUrl: "https://x.test" }, base)).toEqual({
      contactId: null,
      meetingUrl: "https://x.test",
    });
    expect(changedFields({ ...base, title: "New", location: "Gate 2" }, base)).toEqual({ title: "New", location: "Gate 2" });
  });
  it("sends start and end together when either moved", () => {
    const endAt = new Date("2030-01-01T10:00:00Z");
    expect(changedFields({ ...base, endAt }, base)).toEqual({ startAt: base.startAt, endAt });
  });
});
