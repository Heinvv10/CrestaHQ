import { describe, expect, it } from "vitest";
import { buildBookingToolsBlock, toChangeTargets } from "@/lib/comms/ai/booking-prompt";
import type { ChangeableBooking } from "@/lib/comms/ai/booking-engine";
import type { BookingHost, BookingPage } from "@/types/booking";

const hosts: BookingHost[] = [
  { uid: "u-jane", name: "Jane Smith" },
  { uid: "u-jake", name: "Jake Doe" },
];
const page = { name: "Consult", slug: "consult", durationMinutes: 30, timezone: "Africa/Johannesburg" } as BookingPage;
const rrPage = { ...page, hosts, allowHostSelection: true, calendarType: "round_robin" } as BookingPage;
const collectivePage = { ...page, hosts, allowHostSelection: true, calendarType: "collective" } as BookingPage;
const changeable: ChangeableBooking[] = [
  { eventId: "evt-1", startAt: new Date("2026-11-03T08:00:00Z"), page, assignedToUid: null, assignedToName: null },
];

describe("buildBookingToolsBlock", () => {
  it("phone keeps the copy-the-start-value rules", () => {
    const block = buildBookingToolsBlock(page, "phone");
    expect(block).toContain("COPY the start value character-for-character from the [[slots]] result");
    expect(block).not.toContain("HOST SELECTION");
  });

  it("host selection only on pages that assign one host", () => {
    expect(buildBookingToolsBlock(rrPage, "web-text")).toContain("Our team: Jane Smith, Jake Doe");
    expect(buildBookingToolsBlock(collectivePage, "web-text")).not.toContain("HOST SELECTION");
  });

  it("adds the location, the intake questions and the changeable bookings", () => {
    const block = buildBookingToolsBlock(page, "messaging", {
      location: { type: "in_person", description: "In person at 1 Main Rd" },
      intake: [{ id: "q", label: "Why", type: "text", required: true, options: null }],
      changeable: toChangeTargets(changeable),
    });
    expect(block).toContain("WHERE: In person at 1 Main Rd.");
    expect(block).toContain("- q1: Why (required)");
    expect(block).toContain("- b1: Consult on");
  });

  it("with no page, only changes are taught", () => {
    const block = buildBookingToolsBlock(null, "web-text", { changeable: toChangeTargets(changeable) });
    expect(block).toContain("CHANGING AN EXISTING BOOKING");
    expect(block).not.toContain("[[book");
  });
});
