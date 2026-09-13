import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  access: vi.fn(),
  rescheduleWithoutAvailabilityCheck: vi.fn(),
  runRescheduleSideEffects: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: m.access,
}));
vi.mock("@/lib/booking/reschedule", () => ({
  RescheduleRejected: class RescheduleRejected extends Error {
    constructor(
      public readonly httpStatus: number,
      message: string,
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
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: null },
    newToken: "tok1",
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
    event: { id: "evt1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: null },
    newToken: "tok1",
  });
  const res = await post({ startAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:30:00Z" });
  expect(res.status).toBe(200);
  expect(m.runRescheduleSideEffects).toHaveBeenCalledWith(
    expect.objectContaining({ actor: "operator", newRawToken: "tok1" }),
  );
});
