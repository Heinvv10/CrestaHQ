import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  rescheduleWithoutAvailabilityCheck: vi.fn(),
  runRescheduleSideEffects: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
// Territory scoping is covered in ../route.territory-actions.test.ts.
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGate: async () => null }));
vi.mock("@/lib/booking/reschedule", () => ({
  RescheduleRejected: class RescheduleRejected extends Error {
    constructor(
      public readonly httpStatus: number,
      message: string,
      public readonly code?: string,
    ) {
      super(message);
    }
  },
  rescheduleWithoutAvailabilityCheck: m.rescheduleWithoutAvailabilityCheck,
  runRescheduleSideEffects: m.runRescheduleSideEffects,
}));
vi.mock("@/lib/booking/event-token", () => ({
  buildEventPublicUrl: (t: string) => `https://example.com/e/${t}`,
}));

let eventDoc: Record<string, unknown> | undefined;
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: eventDoc !== undefined, data: () => eventDoc }),
      }),
    }),
    doc: () => ({ get: async () => ({ exists: false }) }),
  }),
}));

const { POST } = await import("./route");

function post(body: unknown) {
  return POST(
    new Request("https://example.com/api/events/by-id/evt1/reschedule", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "evt1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  eventDoc = { subAccountId: "sa1" };
  m.access.mockResolvedValue({ uid: "u1", agencyId: "ag1" });
  m.runRescheduleSideEffects.mockResolvedValue({ emailSent: true });
});

it("rejects an invalid time range with 400 before touching Firestore", async () => {
  const res = await post({ startAt: "not-a-date", endAt: "2030-01-01T10:30:00Z" });
  expect(res.status).toBe(400);
  expect(m.rescheduleWithoutAvailabilityCheck).not.toHaveBeenCalled();
});

it("404s when the event doesn't exist", async () => {
  eventDoc = undefined;
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(res.status).toBe(404);
});

it("authenticates against the event's own sub-account", async () => {
  m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "page-a" },
    newToken: "tok1",
    page: { name: "Intro call" },
  });
  await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(m.access).toHaveBeenCalledWith(expect.anything(), "sa1");
});

it("propagates a RescheduleRejected as its own status code", async () => {
  const { RescheduleRejected } = await import("@/lib/booking/reschedule");
  m.rescheduleWithoutAvailabilityCheck.mockRejectedValue(
    new RescheduleRejected(409, "This booking can't be rescheduled anymore."),
  );
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(res.status).toBe(409);
});

it("on success, runs the side effects with actor: operator", async () => {
  m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "page-a" },
    newToken: "tok1",
    page: { name: "Intro call" },
  });
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(res.status).toBe(200);
  expect(m.runRescheduleSideEffects).toHaveBeenCalledWith(
    expect.objectContaining({ actor: "operator", newRawToken: "tok1" }),
  );
});

it("passes the page the transaction read straight into the side effects", async () => {
  m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "page-a" },
    newToken: "tok1",
    page: { name: "Intro call" },
  });
  await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(m.runRescheduleSideEffects).toHaveBeenCalledWith(
    expect.objectContaining({ page: { name: "Intro call" } }),
  );
});

it("reports that the visitor was emailed", async () => {
  m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "page-a" },
    newToken: "tok1",
    page: { name: "Intro call" },
  });
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.notifyEmailSent).toBe(true);
  expect(body.notifyEmailSkipReason).toBeUndefined();
});

it("returns the times it stored, for the caller to show before its snapshot catches up", async () => {
  m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "page-a" },
    newToken: "tok1",
    page: { name: "Intro call" },
  });
  const res = await post({ startAt: "2030-01-01T10:00:00+02:00", endAt: "2030-01-01T10:30:00+02:00" });
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.newStartAt).toBe("2030-01-01T08:00:00.000Z");
  expect(body.newEndAt).toBe("2030-01-01T08:30:00.000Z");
  expect(m.rescheduleWithoutAvailabilityCheck).toHaveBeenCalledWith(
    "evt1",
    new Date(body.newStartAt as string),
    new Date(body.newEndAt as string),
  );
});

it("returns the reschedule count it stored, for the Rescheduled badge", async () => {
  m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "page-a", rescheduleCount: 2 },
    newToken: "tok1",
    page: { name: "Intro call" },
  });
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(((await res.json()) as Record<string, unknown>).rescheduleCount).toBe(2);
});

it("reports why the visitor was NOT emailed", async () => {
  m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "page-a" },
    newToken: "tok1",
    page: { name: "Intro call" },
  });
  m.runRescheduleSideEffects.mockResolvedValue({
    emailSent: false,
    emailSkipReason: "contact_opted_out",
  });
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.notifyEmailSent).toBe(false);
  expect(body.notifyEmailSkipReason).toBe("contact_opted_out");
});

it("returns 400 no_change for an unchanged time, with no side effects", async () => {
  const { RescheduleRejected } = await import("@/lib/booking/reschedule");
  m.rescheduleWithoutAvailabilityCheck.mockRejectedValue(
    new RescheduleRejected(400, "That's already the booking's time.", "no_change"),
  );
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.code).toBe("no_change");
  expect(m.runRescheduleSideEffects).not.toHaveBeenCalled();
});
