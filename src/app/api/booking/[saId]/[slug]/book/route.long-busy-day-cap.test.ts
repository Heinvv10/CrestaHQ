import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SA, mem, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * Through the real availability + book routes and resolver:
 *  - a multi-day busy event (an "Out of office" that began days ago) blocks
 *    slots. The busy read only looked back 8 h, so it was never seen.
 *  - "Max per day" caps BOOKINGS made on the page that day. It used to cap
 *    the free slots offered instead — first N shown, the rest hidden, and
 *    no limit at all on how many were booked.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());

const { POST } = await import("./route");
const { GET } = await import("../availability/route");

const book = (slug: string, s: ReturnType<typeof slot>) =>
  POST(post({ name: "V", email: "v@example.com", phone: "+27600000000", slot: s }), {
    params: Promise.resolve({ saId: SA, slug }),
  });
/** Offered starts on Monday 2026-09-14, as "HH:MM". */
async function offered(slug: string): Promise<string[]> {
  const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ saId: SA, slug }) });
  return ((await res.json()).slots as { startAt: string }[])
    .filter((s) => s.startAt.startsWith("2026-09-14"))
    .map((s) => s.startAt.slice(11, 16));
}
const ts = (iso: string) => {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
};

beforeEach(resetBookingHarness);
afterEach(() => vi.useRealTimers());

describe("a busy event that started days before the window", () => {
  beforeEach(() => {
    seedPage("p");
    mem.seed("events/ooo", {
      subAccountId: SA,
      agencyId: "ag1",
      status: "scheduled",
      title: "Out of office",
      startAt: ts("2026-09-11T00:00:00Z"),
      endAt: ts("2026-09-15T00:00:00Z"),
      assignedToUid: null,
    });
  });

  it("is not offered", async () => {
    expect(await offered("p")).toEqual([]);
  });

  it("is refused at book time", async () => {
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(409);
  });
});

describe("max per day", () => {
  it("offers every free slot while the day is under the cap", async () => {
    seedPage("p", { maxPerDay: 2 });
    seedEvent("b1", "09:00", "09:30", { bookingPageSlug: "p" });
    expect(await offered("p")).toEqual(["09:30", "10:00", "10:30", "11:00", "11:30"]);
  });

  it("offers nothing once the page holds that many bookings that day", async () => {
    seedPage("p", { maxPerDay: 2 });
    seedEvent("b1", "09:00", "09:30", { bookingPageSlug: "p" });
    seedEvent("b2", "11:30", "12:00", { bookingPageSlug: "p" });
    expect(await offered("p")).toEqual([]);
  });

  it("counts only this page's bookings, not other busy time", async () => {
    seedPage("p", { maxPerDay: 1 });
    seedEvent("manual", "09:00", "09:30");
    seedEvent("other", "10:00", "10:30", { bookingPageSlug: "other" });
    expect(await offered("p")).toEqual(["09:30", "10:30", "11:00", "11:30"]);
  });

  it("is enforced at book time", async () => {
    seedPage("p", { maxPerDay: 2 });
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(200);
    expect((await book("p", slot("11:30", "12:00"))).status).toBe(200);
    expect((await book("p", slot("10:00", "10:30"))).status).toBe(409);
  });
});
