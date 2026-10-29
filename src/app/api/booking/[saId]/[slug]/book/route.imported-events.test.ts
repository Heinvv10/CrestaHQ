import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SA, mem, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * An event imported from a member's Google Calendar (`source: "google"`) is
 * not a booking. Through the real availability + book routes and resolver:
 * it blocks no slot (the hosts' Google busy already covers it, and with no
 * host on it, it would block every host), and it adds nothing to a host's
 * round-robin load.
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
const pageEvents = (slug: string) => mem.list("events").filter((e) => e.bookingPageSlug === slug);

beforeEach(resetBookingHarness);
afterEach(() => vi.useRealTimers());

describe("an imported Google event", () => {
  it("leaves its slot offered and bookable", async () => {
    seedPage("p");
    seedEvent("g1", "09:00", "09:30", { source: "google", title: "Dentist" });
    expect(await offered("p")).toContain("09:00");
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(200);
  });

  it("does not block a day as a long event either", async () => {
    seedPage("p");
    mem.seed("events/g-ooo", {
      subAccountId: SA,
      agencyId: "ag1",
      source: "google",
      status: "scheduled",
      startAt: ts("2026-09-11T00:00:00Z"),
      endAt: ts("2026-09-15T00:00:00Z"),
      isLong: true,
      assignedToUid: null,
    });
    expect(await offered("p")).toHaveLength(6);
  });

  it("a manual event in the same slot still blocks it (control)", async () => {
    seedPage("p");
    seedEvent("m1", "09:00", "09:30");
    expect(await offered("p")).not.toContain("09:00");
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(409);
  });

  it("adds nothing to a host's round-robin load", async () => {
    seedPage("rr", { hosts: [{ uid: "a", name: "Ann" }, { uid: "b", name: "Bob" }] });
    // Were these counted, Ann would be busier and the booking would go to Bob.
    seedEvent("g-a1", "11:00", "11:30", { source: "google", assignedToUid: "a" });
    seedEvent("g-a2", "11:30", "12:00", { source: "google", assignedToUid: "a" });
    expect((await book("rr", slot("09:00", "09:30"))).status).toBe(200);
    expect(pageEvents("rr")[0]).toMatchObject({ assignedToUid: "a" });
  });
});
