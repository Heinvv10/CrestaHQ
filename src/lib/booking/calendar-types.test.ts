import { describe, expect, it } from "vitest";
import { bookedEventLabel } from "@/lib/booking/calendar-types";
import { renderBookingReminderEmail } from "@/lib/booking/email";

/**
 * A service booking is named and timed by its service, not the page: the
 * page's durationMinutes is only the default for new services.
 */

const start = new Date("2026-09-14T09:00:00Z");
const end = new Date("2026-09-14T10:00:00Z");
const page = { name: "Salon", durationMinutes: 30 };

describe("bookedEventLabel", () => {
  it("service booking: page name + service, and the event's own length", () => {
    expect(bookedEventLabel(page, { serviceName: "Cut" }, start, end)).toEqual({
      name: "Salon (Cut)",
      durationMinutes: 60,
    });
  });

  it("any other booking keeps the page's name and duration", () => {
    expect(bookedEventLabel(page, { title: "T" }, start, end)).toEqual({
      name: "Salon",
      durationMinutes: 30,
    });
  });

  it("page deleted: falls back to the title and the event's length", () => {
    expect(bookedEventLabel(null, { title: "Old" }, start, end)).toEqual({
      name: "Old",
      durationMinutes: 60,
    });
  });

  it("feeds the reminder email the service and its length", () => {
    const booked = bookedEventLabel(page, { serviceName: "Cut" }, start, end);
    const email = renderBookingReminderEmail(
      {
        recipientName: "Jo",
        businessName: "Biz",
        page: { ...booked, timezone: "UTC", payment: null, confirmationMessage: "" },
        startAt: start,
        endAt: end,
        publicEventUrl: "",
      },
      60,
    );
    expect(email.subject).toContain("Salon (Cut)");
    expect(email.text).toContain("(60 min)");
    expect(email.text).not.toContain("(30 min)");
  });
});
