import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SA, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * SP3 (b) through the real book route and resolver: the book-time
 * re-verify reads busy time far enough past the slot to honour the
 * after-buffer, and date overrides / slot interval hold at book time too.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());

const { POST } = await import("./route");

const book = (slug: string, s: ReturnType<typeof slot>) =>
  POST(post({ name: "V", email: "v@example.com", phone: "+27600000000", slot: s }), {
    params: Promise.resolve({ saId: SA, slug }),
  });

beforeEach(resetBookingHarness);
afterEach(() => vi.useRealTimers());

describe("book-time re-verify", () => {
  it("refuses a slot whose after-buffer runs into an event starting just after it", async () => {
    seedPage("p", { bufferMinutes: 15, slotIntervalMinutes: 30 });
    seedEvent("later", "10:10", "10:40"); // starts 10 min after a 09:30–10:00 slot
    expect((await book("p", slot("09:30", "10:00"))).status).toBe(409);
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(200);
  });

  it("refuses a slot inside the before-buffer of a later booking on the same page", async () => {
    seedPage("p", { bufferBeforeMinutes: 15, slotIntervalMinutes: 30 });
    seedEvent("own", "10:10", "10:40", { bookingPageSlug: "p" });
    expect((await book("p", slot("09:30", "10:00"))).status).toBe(409);
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(200);
  });

  it("refuses a slot inside the before-buffer after an event", async () => {
    seedPage("p", { bufferBeforeMinutes: 15 });
    seedEvent("earlier", "09:50", "10:20");
    expect((await book("p", slot("10:30", "11:00"))).status).toBe(409);
    expect((await book("p", slot("11:00", "11:30"))).status).toBe(200);
  });

  it("sees a long event ending inside the before-buffer (read window reaches back by the pad)", async () => {
    seedPage("p", { bufferBeforeMinutes: 15 });
    // 8h10m long, ends 09:50: starts before the plain 8h lookback from 10:00.
    seedEvent("long", "01:50", "09:50");
    expect((await book("p", slot("10:00", "10:30"))).status).toBe(409);
  });

  it("books on a UTC+12 page (the re-verify walks the right local date)", async () => {
    // Tue 2026-09-15 09:00 in Auckland (NZST, +12) = Mon 21:00Z.
    seedPage("nz", {
      timezone: "Pacific/Auckland",
      workingHours: [{ dayOfWeek: 2, startMinute: 540, endMinute: 600 }],
    });
    expect((await book("nz", slot("21:00", "21:30"))).status).toBe(200);
  });

  it("honours a closed date and an off-grid interval start", async () => {
    seedPage("closed", { dateOverrides: [{ date: "2026-09-14", ranges: [] }] });
    expect((await book("closed", slot("09:00", "09:30"))).status).toBe(409);
    seedPage("quarter", { slotIntervalMinutes: 15 });
    expect((await book("quarter", slot("09:15", "09:45"))).status).toBe(200);
  });
});
