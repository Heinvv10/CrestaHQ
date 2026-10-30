import { beforeEach, describe, expect, it, vi } from "vitest";
import { SA, mem, post, resetBookingHarness, seedPage, slot } from "@/test/booking-harness";

/**
 * Booking locations through the real book route: the event's location text,
 * the booker's address, and Google Meet — whose push must finish BEFORE the
 * confirmation email, because the email carries the booking's own link.
 */

const m = vi.hoisted(() => ({
  order: [] as string[],
  sent: [] as Array<{ to: string; text: string; html: string; attachments?: Array<{ content: string }> }>,
  meet: vi.fn(async (_id: string): Promise<{ meetUrl: string | null }> => ({ meetUrl: null })),
  later: vi.fn(),
}));

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "x@example.com",
  sendEmail: async (input: (typeof m.sent)[number]) => {
    m.order.push(`email:${input.to}`);
    m.sent.push(input);
  },
}));
vi.mock("@/lib/booking/lifecycle", async () => (await h()).bookingMocks.lifecycle());
vi.mock("@/lib/booking/contact-reconcile", async () => (await h()).bookingMocks.reconcile());
vi.mock("@/lib/google-calendar/busy", () => ({ loadGoogleBusyForPage: async () => [] }));
vi.mock("@/lib/google-calendar/push", () => ({
  pushBookingAndGetMeetUrlWithin: async (id: string) => {
    m.order.push("push");
    return m.meet(id);
  },
  pushBookingToGoogleAfterResponse: m.later,
}));

const { POST } = await import("./route");

const book = (extra: Record<string, unknown> = {}) =>
  POST(post({ name: "Visitor", email: "v@example.com", phone: "+27 60 000 0000", slot: slot("09:00", "09:30"), ...extra }), {
    params: Promise.resolve({ saId: SA, slug: "p" }),
  });

const ics = (i = 0) => Buffer.from(m.sent[i].attachments?.[0]?.content ?? "", "base64").toString("utf-8");
const event = () => mem.list("events")[0] as Record<string, unknown>;
const HOSTS = [{ uid: "host_a", name: "Ann" }];

beforeEach(() => {
  resetBookingHarness();
  m.order.length = 0;
  m.sent.length = 0;
  m.meet.mockReset();
  m.meet.mockResolvedValue({ meetUrl: null });
  m.later.mockClear();
  mem.seed(`subAccounts/${SA}/subAccountMembers/host_a`, { uid: "host_a", status: "active", email: "ann@example.com", displayName: "Ann" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Google Meet pages", () => {
  it("await the push, then email the booker the Meet link it returned (email, invite)", async () => {
    seedPage("p", { hosts: HOSTS, location: { type: "google_meet", value: null }, googleMeet: true });
    m.meet.mockResolvedValueOnce({ meetUrl: "https://meet.google.com/abc-defg-hij" });
    const res = await book();
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    expect(m.meet).toHaveBeenCalledWith(eventId);
    expect(m.order[0]).toBe("push");
    expect(m.order).toContain("email:v@example.com");
    const booker = m.sent.find((s) => s.to === "v@example.com")!;
    expect(booker.text).toContain("Join the meeting: https://meet.google.com/abc-defg-hij");
    expect(booker.text).toContain("Where: Google Meet video call");
    expect(ics()).toContain("LOCATION:https://meet.google.com/abc-defg-hij");
    // The push already ran; it is not queued a second time.
    expect(m.later).not.toHaveBeenCalled();
    expect(event().location).toBe("Google Meet video call");
  });

  it("push made no room: the booking still succeeds; the booker is told the link will follow and the host to send one", async () => {
    seedPage("p", { hosts: HOSTS, location: { type: "google_meet", value: null }, googleMeet: true });
    const res = await book();
    expect(res.status).toBe(200);
    expect(mem.list("events")).toHaveLength(1);
    const booker = m.sent.find((s) => s.to === "v@example.com")!;
    expect(booker.text).not.toContain("Join the meeting");
    expect(booker.text).toContain("Where: Google Meet video call (the joining link will follow)");
    const host = m.sent.find((s) => s.to === "ann@example.com")!;
    expect(host.text).toContain("No Google Meet link could be made");
    // The host was told: no timeline row needed.
    expect(mem.list("contacts/c1/activities")).toEqual([]);
  });

  it("no link and no host email possible: a row on the contact's timeline says a link is owed", async () => {
    seedPage("p", { hosts: HOSTS, location: { type: "google_meet", value: null }, googleMeet: true });
    // The host has no email to notify.
    mem.seed(`subAccounts/${SA}/subAccountMembers/host_a`, { uid: "host_a", status: "active", displayName: "Ann" });
    const res = await book();
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    expect(m.sent.map((s) => s.to)).toEqual(["v@example.com"]);
    expect(mem.list("contacts/c1/activities")).toEqual([
      expect.objectContaining({ type: "meet_link_missing", createdBy: "booking", meta: { eventId } }),
    ]);
  });

  it("a link made: no timeline row", async () => {
    seedPage("p", { hosts: HOSTS, location: { type: "google_meet", value: null }, googleMeet: true });
    mem.seed(`subAccounts/${SA}/subAccountMembers/host_a`, { uid: "host_a", status: "active", displayName: "Ann" });
    m.meet.mockResolvedValueOnce({ meetUrl: "https://meet.google.com/abc-defg-hij" });
    expect((await book()).status).toBe(200);
    expect(mem.list("contacts/c1/activities")).toEqual([]);
  });

  it("push made no room: the page's fallback link goes out instead", async () => {
    seedPage("p", {
      hosts: HOSTS,
      location: { type: "google_meet", value: null },
      googleMeet: true,
      meetingUrl: "https://zoom.example/fallback",
    });
    expect((await book()).status).toBe(200);
    const booker = m.sent.find((s) => s.to === "v@example.com")!;
    expect(booker.text).toContain("Join the meeting: https://zoom.example/fallback");
    expect(booker.text).not.toContain("will follow");
  });

  it("a paid hold keeps the push after the response (it confirms at mark-paid)", async () => {
    mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", paypalConfig: { username: "fixture" } });
    seedPage("p", {
      hosts: HOSTS,
      location: { type: "google_meet", value: null },
      googleMeet: true,
      payment: { amount: 50, currency: "USD", description: null, holdHours: 24 },
    });
    expect((await book()).status).toBe(200);
    expect(m.meet).not.toHaveBeenCalled();
    expect(m.later).toHaveBeenCalledTimes(1);
  });
});

describe("other locations", () => {
  it("a non-Meet page pushes after the response, as before", async () => {
    seedPage("p", { location: { type: "in_person", value: "12 Main Rd, Sandton" } });
    expect((await book()).status).toBe(200);
    expect(m.meet).not.toHaveBeenCalled();
    expect(m.later).toHaveBeenCalledTimes(1);
    expect(event().location).toBe("12 Main Rd, Sandton");
    expect(m.sent[0].text).toContain("Where: 12 Main Rd, Sandton");
    expect(ics()).toContain("LOCATION:12 Main Rd\\, Sandton");
  });

  it("'we call you' names the booker's own phone", async () => {
    seedPage("p", { location: { type: "we_call", value: null } });
    expect((await book()).status).toBe(200);
    expect(event().location).toBe("Phone call: we'll call +27 60 000 0000");
    expect(m.sent[0].text).toContain("Where: Phone call: we'll call +27 60 000 0000");
  });

  it("'at their place' needs the booker's address, one plain line, capped", async () => {
    seedPage("p", { location: { type: "their_address", value: null } });
    expect((await book()).status).toBe(400);
    expect((await book({ address: "<b>1 Evil St</b>" })).status).toBe(400);
    expect((await book({ address: "1 Main Rd\nSandton" })).status).toBe(400);
    expect((await book({ address: "x".repeat(301) })).status).toBe(400);
    expect(mem.list("events")).toHaveLength(0);
    expect((await book({ address: "  7 Oak Ave, Pretoria  " })).status).toBe(200);
    expect(event().location).toBe("At your address: 7 Oak Ave, Pretoria");
  });

  it("a phone carrying a line break or markup is refused before anything is written", async () => {
    seedPage("p", { location: { type: "we_call", value: null } });
    for (const phone of ["+27 60\r\nATTENDEE:mailto:evil@example.com", "+27 60\rX", "<b>+27</b>"]) {
      expect((await book({ phone })).status).toBe(400);
    }
    expect(mem.list("events")).toHaveLength(0);
    expect(m.sent).toHaveLength(0);
  });

  it("a name or email with a line break, separator or markup is refused before anything is written", async () => {
    seedPage("p", { location: { type: "we_call", value: null } });
    for (const name of ["Eve\r\nATTENDEE:mailto:evil@example.com", "Eve\u2028x", "Eve\u0085x", "<b>Eve</b>"]) {
      expect((await book({ name })).status).toBe(400);
    }
    for (const email of ["v@example.com\u0085x", "v@exa\u0000mple.com", "v@example.co\u009fm"]) {
      expect((await book({ email })).status).toBe(400);
    }
    expect(mem.list("events")).toHaveLength(0);
    expect(m.sent).toHaveLength(0);
  });

  it.each([
    ["name", 42],
    ["email", { a: 1 }],
    ["phone", ["+27"]],
    ["address", 7],
  ])("a non-string %s is a 400, not a crash", async (field, value) => {
    seedPage("p", { location: { type: "their_address", value: null } });
    const res = await book({ address: "7 Oak Ave", [field]: value });
    expect(res.status).toBe(400);
    expect(mem.list("events")).toHaveLength(0);
  });

  it("an address sent to a page that doesn't ask for one is ignored", async () => {
    seedPage("p", { location: { type: "we_call", value: null } });
    expect((await book({ address: "<script>x</script>" })).status).toBe(200);
    expect(JSON.stringify(event())).not.toContain("script");
  });
});
