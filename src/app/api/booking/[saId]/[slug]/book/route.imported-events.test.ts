import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SA, mem, post, resetBookingHarness, seedEvent, seedPage, slot } from "@/test/booking-harness";

/**
 * An event imported from a member's Google Calendar (`source: "google"`,
 * owner in `importOwnerUid`) is not a booking. Through the real availability
 * + book routes and resolver: it is busy for its OWNER only — from the
 * Firestore copy, so it still holds while their live Google busy fails open —
 * never for another host, never on a hostless page's shared schedule, and it
 * adds nothing to anyone's round-robin load.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
// A Google read that fails: busy.ts records it and fails open (contributes nothing).
const listEvents = vi.hoisted(() => vi.fn(async () => Promise.reject(new Error("503 backendError"))));
vi.mock("@/lib/google-calendar/provider/select", () => ({
  getGcalProviderFor: async () => ({ listEvents, refresh: vi.fn() }),
}));

const { POST } = await import("./route");
const { GET } = await import("../availability/route");

const book = (slug: string, s: ReturnType<typeof slot>) =>
  POST(post({ name: "V", email: "v@example.com", phone: "+27600000000", slot: s }), {
    params: Promise.resolve({ saId: SA, slug }),
  });
/** Offered starts on Monday 2026-09-14, as "HH:MM"; `host` narrows to one host (opted-in pages). */
async function offered(slug: string, host?: string): Promise<string[]> {
  const res = await GET(new Request(`http://x/api${host ? `?host=${host}` : ""}`), {
    params: Promise.resolve({ saId: SA, slug }),
  });
  return ((await res.json()).slots as { startAt: string }[])
    .filter((s) => s.startAt.startsWith("2026-09-14"))
    .map((s) => s.startAt.slice(11, 16));
}
const ts = (iso: string) => {
  const d = new Date(iso);
  return { toDate: () => d, toMillis: () => d.getTime() };
};
const pageEvents = (slug: string) => mem.list("events").filter((e) => e.bookingPageSlug === slug);
const ANN = { uid: "a", name: "Ann" };
const BOB = { uid: "b", name: "Bob" };
/** Ann's own Google event, as the importer writes it: no host fields. */
const annsImported = (id: string, start: string, end: string, over: Record<string, unknown> = {}) =>
  seedEvent(id, start, end, { source: "google", importOwnerUid: "a", title: "Dentist", ...over });

beforeEach(resetBookingHarness);
afterEach(() => vi.useRealTimers());

describe("an imported Google event on a page with hosts", () => {
  it("blocks its owner only: the slot stays offered with the other host, and books to them", async () => {
    seedPage("rr", { calendarType: "round_robin", allowHostSelection: true, hosts: [ANN, BOB] });
    annsImported("g1", "09:00", "09:30");
    expect(await offered("rr", "a")).not.toContain("09:00");
    expect(await offered("rr", "a")).toContain("09:30");
    expect(await offered("rr", "b")).toContain("09:00");
    expect(await offered("rr")).toContain("09:00");
    expect((await book("rr", slot("09:00", "09:30"))).status).toBe(200);
    expect(pageEvents("rr")[0]).toMatchObject({ assignedToUid: "b" });
  });

  it("a collective page needs every host, so the owner's event removes the slot", async () => {
    seedPage("col", { calendarType: "collective", hosts: [ANN, BOB] });
    annsImported("g1", "09:00", "09:30");
    expect(await offered("col")).not.toContain("09:00");
    expect((await book("col", slot("09:00", "09:30"))).status).toBe(409);
  });

  it("still blocks the owner while their Google busy read fails", async () => {
    mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", googleCalendarEnabledByAgency: true });
    mem.seed(`subAccounts/${SA}/subAccountMembers/a`, { uid: "a", status: "active" });
    mem.seed(`subAccounts/${SA}/private/googleCalendar_a`, {
      uid: "a", status: "connected", accessToken: "t", refreshToken: "r",
      accessTokenExpiresAt: Date.now() + 3600_000, lastError: null,
    });
    seedPage("solo", { hosts: [ANN] });
    annsImported("g1", "09:00", "09:30");
    expect(await offered("solo")).not.toContain("09:00");
    expect(listEvents).toHaveBeenCalled();
    expect(mem.read(`subAccounts/${SA}/private/googleCalendar_a`)?.lastError).toBeTruthy();
  });

  it("a cancelled imported event blocks nobody", async () => {
    seedPage("solo", { hosts: [ANN] });
    annsImported("g1", "09:00", "09:30", { status: "cancelled" });
    expect(await offered("solo")).toContain("09:00");
  });

  it("adds nothing to the owner's round-robin load", async () => {
    seedPage("rr", { hosts: [ANN, BOB] });
    annsImported("g1", "11:00", "11:30");
    annsImported("g2", "11:30", "12:00");
    expect((await book("rr", slot("09:00", "09:30"))).status).toBe(200);
    expect(pageEvents("rr")[0]).toMatchObject({ assignedToUid: "a" });
  });

  it("even one wrongly stamped with assignedToUid adds no load", async () => {
    seedPage("rr", { hosts: [ANN, BOB] });
    annsImported("g1", "11:00", "11:30", { assignedToUid: "a" });
    annsImported("g2", "11:30", "12:00", { assignedToUid: "a" });
    expect((await book("rr", slot("09:00", "09:30"))).status).toBe(200);
    expect(pageEvents("rr")[0]).toMatchObject({ assignedToUid: "a" });
  });
});

describe("an imported Google event on a hostless page", () => {
  it("does not block the shared schedule, nor as a long event", async () => {
    seedPage("p");
    annsImported("g1", "09:00", "09:30");
    mem.seed("events/g-ooo", {
      subAccountId: SA,
      agencyId: "ag1",
      source: "google",
      importOwnerUid: "a",
      status: "scheduled",
      startAt: ts("2026-09-11T00:00:00Z"),
      endAt: ts("2026-09-15T00:00:00Z"),
      isLong: true,
    });
    expect(await offered("p")).toHaveLength(6);
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(200);
  });

  it("an owner-less imported event blocks nobody", async () => {
    seedPage("rr", { calendarType: "round_robin", allowHostSelection: true, hosts: [ANN, BOB] });
    seedEvent("g1", "09:00", "09:30", { source: "google" });
    expect(await offered("rr", "a")).toContain("09:00");
    expect(await offered("rr", "b")).toContain("09:00");
  });

  it("a manual event in the same slot still blocks it (control)", async () => {
    seedPage("p");
    seedEvent("m1", "09:00", "09:30");
    expect(await offered("p")).not.toContain("09:00");
    expect((await book("p", slot("09:00", "09:30"))).status).toBe(409);
  });
});
