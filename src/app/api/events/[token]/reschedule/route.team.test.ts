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

const viewStarts = async (slug: string, eventId: string) => {
  const { GET } = await import("@/app/api/booking/[saId]/[slug]/availability/route");
  const res = await GET(new Request(`http://x/api?excludeEventId=${eventId}`), {
    params: Promise.resolve({ saId: "sa1", slug }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()).slots as { startAt: string }[]).map((s) => s.startAt);
};

describe("a hostless booking on a page that has since gained hosts", () => {
  it("cannot move onto another host's booking; every event still blocks it", async () => {
    seedPage("grew", { hosts: [A, B] });
    const token = seedBooking("mine", "grew", "09:00", "09:30");
    seedEvent("bobs", "10:00", "10:30", { assignedToUid: "b" });

    expect(await viewStarts("grew", "mine")).not.toContain(at("10:00").toISOString());
    expect((await move(token, "10:00", "10:30")).status).toBe(409);
    expect((await move(token, "10:30", "11:00")).status).toBe(200);
  });
});

describe("a booking whose host is no longer on the page", () => {
  it("still moves, on its own host's calendar and the page hours", async () => {
    mem.seed("subAccounts/sa1/subAccountMembers/a", { uid: "a", status: "active" });
    seedPage("left", { hosts: [B] });
    const token = seedBooking("mine", "left", "09:00", "09:30", { assignedToUid: "a" });
    seedEvent("anns", "11:00", "11:30", { assignedToUid: "a" });
    seedEvent("bobs", "10:00", "10:30", { assignedToUid: "b" });

    const view = await viewStarts("left", "mine");
    expect(view).toContain(at("10:00").toISOString());
    expect(view).not.toContain(at("11:00").toISOString());
    expect((await move(token, "11:00", "11:30")).status).toBe(409);
    const res = await move(token, "10:00", "10:30");
    expect(res.status).toBe(200);
    expect(mem.read("events/mine")?.assignedToUid).toBe("a");
  });
});

describe("a booking whose host has left the business", () => {
  it.each([
    ["no longer a member", null],
    ["removed", { uid: "a", status: "removed" }],
  ])("%s: refused with a clear 409, in the view and the move", async (_label, memberDoc) => {
    if (memberDoc) mem.seed("subAccounts/sa1/subAccountMembers/a", memberDoc);
    seedPage("left", { hosts: [B] });
    const token = seedBooking("mine", "left", "09:00", "09:30", {
      assignedToUid: "a",
      assignedToName: "Ann",
    });
    const message = "Ann is no longer available — please contact the business to rebook.";

    const { GET } = await import("@/app/api/booking/[saId]/[slug]/availability/route");
    const view = await GET(new Request("http://x/api?excludeEventId=mine"), {
      params: Promise.resolve({ saId: "sa1", slug: "left" }),
    });
    expect(view.status).toBe(409);
    expect((await view.json()).error).toBe(message);

    const res = await move(token, "10:00", "10:30");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(message);
    const unmoved = mem.read("events/mine")?.startAt as { toMillis: () => number };
    expect(unmoved.toMillis()).toBe(at("09:00").getTime());
  });
});

describe("a service booking whose service was deleted", () => {
  it("moves by its own length", async () => {
    seedPage("svc", {
      calendarType: "service",
      services: [{ id: "trim", name: "Trim", durationMinutes: 30, description: null }],
    });
    const token = seedBooking("mine", "svc", "09:00", "10:00", { serviceId: "cut" });

    const today = (await viewStarts("svc", "mine")).filter((s) => s.startsWith("2026-09-14"));
    expect(today).toEqual([at("09:00").toISOString(), at("10:00").toISOString(), at("11:00").toISOString()]);
    expect((await move(token, "11:00", "11:30")).status).toBe(409); // not the page's 30 min
    expect((await move(token, "10:00", "11:00")).status).toBe(200);
  });

  it("a booking from before the page offered services moves by its own length", async () => {
    seedPage("svc2", {
      calendarType: "service",
      services: [{ id: "trim", name: "Trim", durationMinutes: 30, description: null }],
    });
    const token = seedBooking("mine", "svc2", "09:00", "10:00");
    expect((await move(token, "11:00", "12:00")).status).toBe(200);
  });
});

describe("a malformed booking on a service page", () => {
  it("ends before it starts: the view offers nothing and the move is refused, promptly", async () => {
    seedPage("svc", {
      calendarType: "service",
      services: [{ id: "trim", name: "Trim", durationMinutes: 30, description: null }],
    });
    const token = seedBooking("bad", "svc", "10:00", "09:00", { serviceId: "gone" });
    expect(await viewStarts("svc", "bad")).toEqual([]);
    expect((await move(token, "10:00", "10:30")).status).toBe(409);
  });
});

describe("the reschedule view's sizing", () => {
  it("comes from the booking's own service, never the query's serviceId", async () => {
    seedPage("svc", {
      calendarType: "service",
      services: [
        { id: "cut", name: "Cut", durationMinutes: 60, description: null },
        { id: "trim", name: "Trim", durationMinutes: 30, description: null },
      ],
    });
    seedBooking("mine", "svc", "09:00", "10:00", { serviceId: "cut" });
    seedBooking("old", "svc", "09:00", "10:30");
    const { GET } = await import("@/app/api/booking/[saId]/[slug]/availability/route");
    for (const id of ["mine", "old"]) {
      const res = await GET(new Request(`http://x/api?excludeEventId=${id}&serviceId=trim`), {
        params: Promise.resolve({ saId: "sa1", slug: "svc" }),
      });
      const body = (await res.json()) as { slots: { startAt: string; endAt: string }[]; durationMinutes: number };
      const len = (Date.parse(body.slots[0].endAt) - Date.parse(body.slots[0].startAt)) / 60_000;
      expect([id, len, body.durationMinutes]).toEqual(id === "mine" ? [id, 60, 60] : [id, 90, 90]);
    }
  });
});

describe("the reschedule view's excludeEventId", () => {
  it("is ignored for an event booked on another page", async () => {
    seedPage("solo");
    seedPage("elsewhere");
    seedEvent("theirs", "10:00", "10:30", { bookingPageSlug: "elsewhere" });
    // Naming someone else's booking must not free its time on this page.
    expect(await viewStarts("solo", "theirs")).not.toContain(at("10:00").toISOString());
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
