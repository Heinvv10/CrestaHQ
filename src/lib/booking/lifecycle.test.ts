import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

const m = vi.hoisted(() => ({
  fireWorkflowTrigger: vi.fn(),
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: m.fireWorkflowTrigger,
}));
// fireBookingTrigger only needs getAdminDb for the modules it pulls in
// transitively via other lifecycle.ts exports; stub it out so importing
// this file doesn't need a live Firestore.
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("@/lib/automations/qstash", () => ({
  publishCallback: vi.fn(),
  qstashIsConfigured: () => false,
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));

const { fireBookingTrigger } = await import("./lifecycle");

const event = {
  id: "evt1",
  agencyId: "ag1",
  subAccountId: "sa1",
  contactId: "c1",
  bookingPageSlug: "page-a",
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The one place a swapped booking.showed/booking.no_show mapping (or any
 * other event_* -> booking.* mix-up) would surface — before this test, the
 * reviewer flagged that swapping the two in fireBookingTrigger kept the
 * whole suite green. Assert every input maps to its exact output type AND
 * carries {eventId, bookingPageSlug} as trigger context.
 */
describe("fireBookingTrigger — event_* -> booking.* mapping", () => {
  const cases: [
    Parameters<typeof fireBookingTrigger>[1],
    string,
  ][] = [
    ["event_booked", "booking.created"],
    ["event_cancelled", "booking.cancelled"],
    ["event_rescheduled", "booking.rescheduled"],
    ["event_paid", "booking.confirmed"],
    ["event_confirmed", "booking.confirmed"],
    ["event_completed", "booking.showed"],
    ["event_no_show", "booking.no_show"],
  ];

  it.each(cases)("%s -> %s", async (trigger, expectedType) => {
    await fireBookingTrigger(event, trigger);
    expect(m.fireWorkflowTrigger).toHaveBeenCalledWith({
      agencyId: "ag1",
      subAccountId: "sa1",
      type: expectedType,
      contactId: "c1",
      context: { eventId: "evt1", bookingPageSlug: "page-a" },
    });
  });

  it("passes bookingPageSlug: null for a manual event", async () => {
    await fireBookingTrigger({ ...event, bookingPageSlug: null }, "event_completed");
    expect(m.fireWorkflowTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ context: { eventId: "evt1", bookingPageSlug: null } }),
    );
  });

  it("no-ops without a contactId", async () => {
    await fireBookingTrigger({ ...event, contactId: null }, "event_completed");
    await flushAfterResponse();
    expect(m.fireWorkflowTrigger).not.toHaveBeenCalled();
  });
});
