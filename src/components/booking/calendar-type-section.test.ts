import { describe, expect, it } from "vitest";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import { fieldsForType, newServiceId, typeDefaults } from "./calendar-type-section";
import type { BookingPageFormData } from "@/types/booking";

/** The editor's type switch and service ids (SP3 review round 1). */

const form = (over: Partial<BookingPageFormData> = {}): BookingPageFormData => ({
  ...defaultBookingPageFormData("p", "UTC"),
  ...over,
});
const svc = { id: "svc_keep", name: "Cut", durationMinutes: 60, description: null };

describe("fieldsForType", () => {
  it("clears every field the new type doesn't use", () => {
    const stale = form({
      calendarType: "service",
      distribution: "availability",
      seatsPerSlot: 7,
      services: [svc],
    });
    expect(fieldsForType(stale, "personal")).toEqual({
      calendarType: "personal",
      seatsPerSlot: null,
      services: null,
      distribution: null,
    });
    expect(fieldsForType(stale, "class")).toMatchObject({ seatsPerSlot: 7, services: null, distribution: null });
    expect(fieldsForType(stale, "round_robin")).toMatchObject({
      distribution: "availability",
      services: null,
      seatsPerSlot: null,
    });
  });

  it("keeps the new type's own fields, or defaults them", () => {
    expect(fieldsForType(form({ services: [svc] }), "service").services).toEqual([svc]);
    expect(fieldsForType(form(), "class").seatsPerSlot).toBe(10);
    expect(fieldsForType(form(), "service").services).toHaveLength(1);
  });
});

describe("service ids", () => {
  it("are random, never the positional service-N", () => {
    const ids = new Set(Array.from({ length: 50 }, newServiceId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^svc_[0-9a-f]{8}$/);
    expect(typeDefaults("service", 30).services?.[0].id).toMatch(/^svc_/);
  });
});
