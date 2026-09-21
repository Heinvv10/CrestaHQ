import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mem, resetBookingHarness, seedEvent, seedPage, at } from "@/test/booking-harness";

/**
 * The voice agent lists and books through the same resolver as the public
 * page, keeping its one deliberate difference: a slot it already offered is
 * not refused at confirm time just because the minimum notice has moved.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/server/contacts-service", () => ({
  emitContactCreatedById: async () => undefined,
}));

const { bookVoiceSlot, getVoiceBookingContext, listVoiceSlots } = await import(
  "./voice-booking-service"
);

const A = { uid: "a", name: "Ann" };
const B = { uid: "b", name: "Bob" };

const bookAt = (page: Parameters<typeof bookVoiceSlot>[0]["page"], hhmm: string) =>
  bookVoiceSlot({
    subAccountId: "sa1",
    agencyId: "ag1",
    page,
    startAtIso: at(hhmm).toISOString(),
    callerName: "Caller",
    callerPhone: "+27600000000",
    contactId: "c1",
  });

beforeEach(resetBookingHarness);
afterEach(() => vi.useRealTimers());

describe("voice booking", () => {
  it("lists collective slots only where every host is free, and books all hosts", async () => {
    const page = seedPage("col", { calendarType: "collective", hosts: [A, B] });
    seedEvent("bobs", "09:00", "09:30", { assignedToUid: "b" });

    const slots = await listVoiceSlots("sa1", page);
    expect(slots[0].startAt.toISOString()).toBe("2026-09-14T09:30:00.000Z");

    expect(await bookAt(page, "09:00")).toEqual({ ok: false, code: "slot_taken" });
    expect(await bookAt(page, "09:30")).toMatchObject({ ok: true });
    const booked = mem.list("events").find((e) => e.bookingPageSlug === "col");
    expect(booked).toMatchObject({ assignedToUid: "a", hostUids: ["a", "b"] });
  });

  it("confirms an offered slot inside the moving minimum notice", async () => {
    // 4h notice at 06:00 → listing starts at 10:00; 09:00 was offered earlier.
    const page = seedPage("solo", { minNoticeHours: 4 });
    const slots = await listVoiceSlots("sa1", page);
    expect(slots[0].startAt.toISOString()).toBe("2026-09-14T10:00:00.000Z");
    expect(await bookAt(page, "09:00")).toMatchObject({ ok: true });
  });

  it("refuses service pages — a call has no service step", async () => {
    seedPage("svc", {
      calendarType: "service",
      services: [{ id: "cut", name: "Cut", durationMinutes: 60, description: null }],
    });
    expect(await getVoiceBookingContext("sa1", "svc")).toMatchObject({
      bookable: false,
      reason: "page_is_service",
    });
  });
});
