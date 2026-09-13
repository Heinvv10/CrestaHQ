import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mem, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * Reschedule re-verifies with the page's type and host rules, for the
 * event's OWN host(s). It used to check page hours only with every host's
 * events blocking, so a team booking could not move into a time only
 * another host was busy for (SP3 A8).
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());

const { POST } = await import("./route");
const { issueEventToken } = await import("@/lib/booking/event-token");

const A = { uid: "a", name: "Ann" };
const B = { uid: "b", name: "Bob" };

/** Seed the booking being moved and return its public token. */
function seedBooking(id: string, page: string, start: string, end: string, over = {}) {
  const { token, hash } = issueEventToken(id);
  seedEvent(id, start, end, { bookingPageSlug: page, publicTokenHash: hash, ...over });
  return token;
}
const move = (token: string, start: string, end: string) =>
  POST(post({ slot: slot(start, end) }), { params: Promise.resolve({ token }) });
const startOf = (id: string) => (mem.read(`events/${id}`)?.startAt as Date).getTime();

beforeEach(resetBookingHarness);
afterEach(() => vi.useRealTimers());

describe("round robin", () => {
  it("moves into a time only another host is busy for", async () => {
    seedPage("rr", { hosts: [A, B] });
    const token = seedBooking("mine", "rr", "09:00", "09:30", { assignedToUid: "a" });
    seedEvent("bobs", "10:00", "10:30", { assignedToUid: "b" });

    const res = await move(token, "10:00", "10:30");
    expect(res.status).toBe(200);
    expect(startOf("mine")).toBe(at("10:00").getTime());
  });

  it("refuses a time its own host is busy for, even while another host is free", async () => {
    seedPage("rr", { hosts: [A, B] });
    const token = seedBooking("mine", "rr", "09:00", "09:30", { assignedToUid: "a" });
    seedEvent("anns", "11:00", "11:30", { assignedToUid: "a" });
    expect((await move(token, "11:00", "11:30")).status).toBe(409);
  });

  it("the availability list for the reschedule view is that host's", async () => {
    seedPage("rr", { hosts: [A, B] });
    seedBooking("mine", "rr", "09:00", "09:30", { assignedToUid: "a" });
    seedEvent("anns", "11:00", "11:30", { assignedToUid: "a" });
    const { GET } = await import("@/app/api/booking/[saId]/[slug]/availability/route");
    const res = await GET(new Request("http://x/api?excludeEventId=mine"), {
      params: Promise.resolve({ saId: "sa1", slug: "rr" }),
    });
    const starts = ((await res.json()).slots as { startAt: string }[]).map((s) => s.startAt);
    expect(starts).toContain("2026-09-14T09:00:00.000Z"); // its own slot
    expect(starts).not.toContain("2026-09-14T11:00:00.000Z"); // Bob is free, Ann isn't
  });
});

describe("collective", () => {
  it("needs every one of its hosts free", async () => {
    seedPage("col", { calendarType: "collective", hosts: [A, B] });
    const token = seedBooking("mine", "col", "09:00", "09:30", {
      assignedToUid: "a",
      hostUids: ["a", "b"],
    });
    seedEvent("bobs", "10:00", "10:30", { assignedToUid: "b" });
    expect((await move(token, "10:00", "10:30")).status).toBe(409);
    expect((await move(token, "10:30", "11:00")).status).toBe(200);
  });
});

describe("class", () => {
  it("takes a free seat and refuses a full slot", async () => {
    seedPage("cls", { calendarType: "class", seatsPerSlot: 2 });
    const token = seedBooking("mine", "cls", "09:00", "09:30");
    seedEvent("other1", "10:00", "10:30", { bookingPageSlug: "cls" });
    expect((await move(token, "10:00", "10:30")).status).toBe(200);

    seedEvent("other2", "11:00", "11:30", { bookingPageSlug: "cls" });
    seedEvent("other3", "11:00", "11:30", { bookingPageSlug: "cls" });
    const next = seedBooking("mine2", "cls", "09:30", "10:00");
    expect((await move(next, "11:00", "11:30")).status).toBe(409);
  });
});

describe("legacy hostless page", () => {
  it("is still blocked by any event in the sub-account", async () => {
    seedPage("solo");
    const token = seedBooking("mine", "solo", "09:00", "09:30");
    seedEvent("someones", "10:00", "10:30", { assignedToUid: "x" });
    expect((await move(token, "10:00", "10:30")).status).toBe(409);
    expect((await move(token, "10:30", "11:00")).status).toBe(200);
  });
});
