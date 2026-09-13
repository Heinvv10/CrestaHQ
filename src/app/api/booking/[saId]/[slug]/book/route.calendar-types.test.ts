import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SA,
  mem,
  post,
  resetBookingHarness,
  seedEvent,
  seedPage,
  slot,
} from "@/test/booking-harness";

/**
 * Book + availability routes per calendar type, through the real resolver:
 * who a booking goes to, what gets stamped on the event, and when the
 * transactional re-verify refuses.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());

const { POST } = await import("./route");
const { GET } = await import("../availability/route");

const book = (slug: string, extra: object) =>
  POST(
    post({ name: "Visitor", email: "v@example.com", phone: "+27600000000", ...extra }),
    { params: Promise.resolve({ saId: SA, slug }) },
  );
const availability = async (slug: string, qs = "") => {
  const res = await GET(new Request(`http://x/api?${qs}`), {
    params: Promise.resolve({ saId: SA, slug }),
  });
  return { status: res.status, body: await res.json() };
};
const pageEvents = (slug: string) =>
  mem.list("events").filter((e) => e.bookingPageSlug === slug);

const A = { uid: "a", name: "Ann" };
const B = { uid: "b", name: "Bob" };

beforeEach(resetBookingHarness);
afterEach(() => vi.useRealTimers());

describe("collective", () => {
  it("refuses a slot one host is busy for, and books every host otherwise", async () => {
    seedPage("col", { calendarType: "collective", hosts: [A, B] });
    seedEvent("busy-b", "09:00", "09:30", { assignedToUid: "b" });

    expect((await book("col", { slot: slot("09:00", "09:30") })).status).toBe(409);
    const res = await book("col", { slot: slot("09:30", "10:00") });
    expect(res.status).toBe(200);
    const [ev] = pageEvents("col");
    expect(ev).toMatchObject({ assignedToUid: "a", assignedToName: "Ann", hostUids: ["a", "b"] });
  });

  it("its event then blocks every listed host on a round-robin page", async () => {
    seedPage("col", { calendarType: "collective", hosts: [A, B] });
    seedPage("rr", { hosts: [A, B] });
    expect((await book("col", { slot: slot("09:00", "09:30") })).status).toBe(200);
    expect((await book("rr", { slot: slot("09:00", "09:30") })).status).toBe(409);
  });
});

describe("round robin", () => {
  it("availability mode gives the booking to the highest-priority free host", async () => {
    seedPage("rr", {
      calendarType: "round_robin",
      distribution: "availability",
      hosts: [A, { ...B, priority: 3 }],
    });
    // Bob is already busier — equal mode would pick Ann.
    seedEvent("bob-later", "11:00", "11:30", { assignedToUid: "b" });
    expect((await book("rr", { slot: slot("09:00", "09:30") })).status).toBe(200);
    expect(pageEvents("rr")[0]).toMatchObject({ assignedToUid: "b" });
    expect(pageEvents("rr")[0].hostUids).toBeUndefined();
  });

  it("a legacy page with hosts keeps least-loaded assignment", async () => {
    seedPage("rr", { hosts: [A, B] });
    seedEvent("ann-later", "11:00", "11:30", { assignedToUid: "a" });
    expect((await book("rr", { slot: slot("09:00", "09:30") })).status).toBe(200);
    expect(pageEvents("rr")[0]).toMatchObject({ assignedToUid: "b" });
  });
});

describe("class", () => {
  it("fills one slot up to its seats, then refuses; availability counts down", async () => {
    seedPage("cls", { calendarType: "class", seatsPerSlot: 2 });
    const first = await availability("cls");
    expect(first.body.slots[0]).toMatchObject({ seatsLeft: 2 });

    expect((await book("cls", { slot: slot("09:00", "09:30") })).status).toBe(200);
    expect((await availability("cls")).body.slots[0]).toMatchObject({ seatsLeft: 1 });
    expect((await book("cls", { slot: slot("09:00", "09:30") })).status).toBe(200);
    expect((await book("cls", { slot: slot("09:00", "09:30") })).status).toBe(409);
    expect(pageEvents("cls")).toHaveLength(2);
    expect((await availability("cls")).body.slots[0].startAt).toBe("2026-09-14T09:30:00.000Z");
  });
});

describe("service", () => {
  const services = [{ id: "cut", name: "Cut", durationMinutes: 60, description: null }];

  it("needs a service, sizes the slot to it and stamps it", async () => {
    seedPage("svc", { calendarType: "service", services });

    expect((await availability("svc")).status).toBe(400);
    const listed = await availability("svc", "serviceId=cut");
    expect(listed.body.durationMinutes).toBe(60);
    expect(listed.body.slots[0]).toEqual({
      startAt: "2026-09-14T09:00:00.000Z",
      endAt: "2026-09-14T10:00:00.000Z",
    });

    expect((await book("svc", { slot: slot("09:00", "10:00") })).status).toBe(400);
    expect((await book("svc", { serviceId: "cut", slot: slot("09:00", "09:30") })).status).toBe(409);
    expect((await book("svc", { serviceId: "cut", slot: slot("09:00", "10:00") })).status).toBe(200);
    expect(pageEvents("svc")[0]).toMatchObject({ serviceId: "cut", serviceName: "Cut" });
  });
});

describe("legacy hostless page", () => {
  it("is still blocked by any event in the sub-account, and stamps no host", async () => {
    seedPage("solo");
    seedEvent("someones", "09:00", "09:30", { assignedToUid: "x" });
    expect((await book("solo", { slot: slot("09:00", "09:30") })).status).toBe(409);
    expect((await book("solo", { slot: slot("09:30", "10:00") })).status).toBe(200);
    const [ev] = pageEvents("solo");
    expect(ev.assignedToUid).toBeNull();
    expect("hostUids" in ev || "serviceId" in ev).toBe(false);
  });
});
