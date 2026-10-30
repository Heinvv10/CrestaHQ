import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark-paid on a Google Meet page whose push misses its deadline and lands
 * later (detached): the late link is emailed only where mark-paid's own
 * confirmation went. With an approver's `expect` pin that no longer matches
 * the contact's address, the confirmation is withheld — and so is the late
 * link. Real mark-paid → real push (Google stubbed, hanging) → real
 * follow-up → real sendEmail; only the SMTP wire is faked.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: async () => undefined,
  recordBookingActivity: async () => undefined,
  scheduleEventReminders: async () => undefined,
}));
const google = vi.hoisted(() => ({
  release: (_v: { created: boolean; meetUrl: string | null }) => {},
  putEvent: vi.fn(),
}));
vi.mock("@/lib/google-calendar/provider/select", () => ({
  getGcalProviderFor: async () => ({ putEvent: google.putEvent, deleteEvent: vi.fn(), refresh: vi.fn() }),
}));
// The real deadline is 6 s; the same code with 50 ms.
vi.mock("@/lib/google-calendar/push", async (orig) => {
  const real = await orig<typeof import("@/lib/google-calendar/push")>();
  return {
    ...real,
    pushBookingAndGetMeetUrlWithin: (id: string, o: Parameters<typeof real.pushBookingAndGetMeetUrlWithin>[1] = {}) =>
      real.pushBookingAndGetMeetUrlWithin(id, { ...o, ms: 50 }),
  };
});

const { SA, AGENCY, mem, resetSeam, smtpSend } = await s();
const { markBookingPaidServerSide } = await import("./bookings-service");
const { flushAfterResponse } = await import("@/lib/server/after-response");
const { MEET_LINK_NOT_EMAILED_NOTE } = await import("@/lib/booking/meet-link-missing");

const MEET_LINK = "https://meet.google.com/late-room-xyz";
const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const start = new Date(Date.now() + 3 * 86_400_000);
const recipients = () => smtpSend.mock.calls.map(([, m]) => m.to);

beforeEach(() => {
  resetSeam();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";
  mem.seed(`subAccounts/${SA}`, { ...(mem.read(`subAccounts/${SA}`) as object), googleCalendarEnabledByAgency: true });
  mem.seed(`subAccounts/${SA}/subAccountMembers/h`, { uid: "h", status: "active", displayName: "Hana" });
  mem.seed(`subAccounts/${SA}/private/googleCalendar_h`, {
    uid: "h",
    status: "connected",
    accessToken: "tok-h",
    refreshToken: "r-h",
    accessTokenExpiresAt: Date.now() + 3600_000,
  });
  mem.seed(`subAccounts/${SA}/bookingPages/p`, {
    slug: "p",
    name: "Intro",
    timezone: "UTC",
    durationMinutes: 30,
    hosts: [{ uid: "h", name: "Hana" }],
    location: { type: "google_meet", value: null },
    googleMeet: true,
  });
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "awaiting_payment",
    title: "Intro",
    contactId: "c1",
    bookingPageSlug: "p",
    source: "booking_page",
    assignedToUid: "h",
    meetingUrl: null,
    location: "Google Meet video call",
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1_800_000)),
  });
  mem.seed("contacts/c1", { name: "Thandi", email: "now@example.co.za", agencyId: AGENCY, subAccountId: SA });
  google.putEvent.mockReset();
  google.putEvent.mockImplementation(() => new Promise((resolve) => (google.release = resolve)));
});

async function payThenLandRoom(expectEmailTo?: string | null, beforeRoom?: () => void) {
  const res = await markBookingPaidServerSide({
    eventId: "e1",
    expectSubAccountId: SA,
    paidByUid: null,
    ...(expectEmailTo !== undefined ? { expect: { contactId: "c1", emailTo: expectEmailTo, stepsFingerprints: {} } } : {}),
  });
  expect(res.ok).toBe(true);
  beforeRoom?.();
  google.release({ created: true, meetUrl: MEET_LINK });
  await flushAfterResponse();
  // The late room did land on the booking either way.
  expect(mem.read("events/e1")).toMatchObject({ meetingUrl: MEET_LINK });
}

describe("mark-paid + a Meet link that lands after the deadline", () => {
  it("withheld by the approver's pin: neither the confirmation nor the late link is emailed — and the row says so", async () => {
    await payThenLandRoom("reviewed@example.co.za");
    expect(recipients()).toEqual([]);
    const rows = mem.list("contacts/c1/activities").filter((a) => a.type === "meet_link_missing");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: MEET_LINK_NOT_EMAILED_NOTE, meta: expect.objectContaining({ pending: false }) });
  });

  it("the approver reviewed no address (pin null): nobody gets the late link, and the row says it wasn't emailed", async () => {
    await payThenLandRoom(null);
    expect(recipients()).toEqual([]);
    const rows = mem.list("contacts/c1/activities").filter((a) => a.type === "meet_link_missing");
    expect(rows).toEqual([expect.objectContaining({ content: MEET_LINK_NOT_EMAILED_NOTE })]);
  });

  it("the contact's address changes after mark-paid, before the room lands: the late link stays with the pin", async () => {
    await payThenLandRoom("now@example.co.za", () =>
      mem.seed("contacts/c1", { ...(mem.read("contacts/c1") as object), email: "changed@example.co.za" }),
    );
    expect(recipients()).toEqual(["now@example.co.za"]);
  });

  it("pin still matching: the confirmation, then the late link, to that address", async () => {
    await payThenLandRoom("now@example.co.za");
    expect(recipients()).toEqual(["now@example.co.za", "now@example.co.za"]);
    expect((smtpSend.mock.calls[1][1] as unknown as { text: string }).text).toContain(MEET_LINK);
  });

  it("no pin: the confirmation says the link will follow, and the late link follows", async () => {
    await payThenLandRoom();
    const sent = smtpSend.mock.calls.map(([, m]) => m as unknown as { to: string; text: string });
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("the joining link will follow");
    expect(sent[1].text).toContain(MEET_LINK);
  });
});
