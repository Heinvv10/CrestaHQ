import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SA, mem, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * End to end: the calendar import (real runCalendarImport) writes a member's
 * Google event, and the real availability + book routes then keep that
 * member — and only that member — off its slot, while their live Google
 * busy read fails. Opting out frees the slot again. (C0's
 * route.imported-events.test.ts covers the reader with hand-seeded docs;
 * this one proves the importer's docs are what that reader expects.)
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", async () => (await h()).bookingMocks.resend());
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
const g = vi.hoisted(() => ({
  // The live busy read fails (busy.ts fails open): only the imported copy can block.
  listEvents: vi.fn(async () => Promise.reject(new Error("503 backendError"))),
  syncEvents: vi.fn(),
  refresh: vi.fn(),
  putEvent: vi.fn(async () => {}),
  deleteEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/google-calendar/provider/select", () => ({ getGcalProviderFor: async () => g }));

const { POST } = await import("./route");
const { GET } = await import("../availability/route");
const { runCalendarImport } = await import("@/lib/google-calendar/import");
const { setImportMode } = await import("@/lib/google-calendar/import-state");
const { flushAfterResponse } = await import("@/lib/server/after-response");

const ANN = { uid: "a", name: "Ann" };
const BOB = { uid: "b", name: "Bob" };
const book = (s: ReturnType<typeof slot>) =>
  POST(post({ name: "V", email: "v@example.com", phone: "+27600000000", slot: s }), {
    params: Promise.resolve({ saId: SA, slug: "rr" }),
  });
async function offered(host: string): Promise<string[]> {
  const res = await GET(new Request(`http://x/api?host=${host}`), { params: Promise.resolve({ saId: SA, slug: "rr" }) });
  return ((await res.json()).slots as { startAt: string }[])
    .filter((s) => s.startAt.startsWith("2026-09-14"))
    .map((s) => s.startAt.slice(11, 16));
}

beforeEach(() => {
  resetBookingHarness();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mem.seed(`subAccounts/${SA}`, {
    agencyId: "ag1",
    name: "Fixture",
    googleCalendarEnabledByAgency: true,
    calendarImportAllowed: true,
  });
  for (const uid of ["a", "b"]) mem.seed(`subAccounts/${SA}/subAccountMembers/${uid}`, { uid, status: "active" });
  mem.seed(`subAccounts/${SA}/private/googleCalendar_a`, {
    uid: "a", agencyId: "ag1", subAccountId: SA, status: "connected", accessToken: "t", refreshToken: "r",
    accessTokenExpiresAt: Date.now() + 3_600_000, lastError: null, importMode: "busy", importGeneration: 1,
  });
  seedPage("rr", { calendarType: "round_robin", allowHostSelection: true, hosts: [ANN, BOB] });
  g.syncEvents.mockResolvedValue({
    items: [{ id: "dentist", status: "confirmed", summary: "Dentist", start: { dateTime: "2026-09-14T09:00:00Z" }, end: { dateTime: "2026-09-14T09:30:00Z" } }],
    timeZone: "UTC",
    nextSyncToken: "tok",
    truncated: false,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an imported Google event, through the real importer and booking routes", () => {
  it("blocks its owner only, while their live Google busy fails open; the slot books to the other host", async () => {
    expect(await runCalendarImport(SA, "a")).toMatchObject({ ok: true, written: 1 });
    expect(await offered("a")).not.toContain("09:00");
    expect(await offered("a")).toContain("09:30");
    expect(await offered("b")).toContain("09:00");
    expect(g.listEvents).toHaveBeenCalled();
    expect((await book(slot("09:00", "09:30"))).status).toBe(200);
    const booked = mem.list("events").filter((e) => e.bookingPageSlug === "rr");
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ assignedToUid: "b" });
    // Nothing went back to Google: Bob has no connection, and Ann's import is not a booking.
    await flushAfterResponse();
    expect(g.putEvent).not.toHaveBeenCalled();
  });

  it("opting out frees the owner's slot at once", async () => {
    await runCalendarImport(SA, "a");
    expect(await offered("a")).not.toContain("09:00");
    await setImportMode(SA, "a", "off");
    expect(await offered("a")).toContain("09:00");
  });
});
