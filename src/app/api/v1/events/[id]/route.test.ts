import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/v1/events/:id — before the shared event-status-service and
 * reschedule module, this route wrote `status`/`startAt`/`endAt` raw: an
 * API key could un-cancel a booking (re-occupying its slot), jump straight
 * from awaiting_payment to completed, or move a booking-page event's time
 * with zero trigger/activity/email bookkeeping. This asserts the tightened
 * contract.
 */

const CTX = {
  agencyId: "ag1",
  subAccountId: "sa1",
  keyId: "key1",
  keyPrefix: "lsk_abcd",
  mode: "live" as "live" | "test",
  scopes: ["admin"],
  requestId: "req_test",
  apiVersion: "2026-01-01",
};

let eventDoc: Record<string, unknown>;
const setCalls: Record<string, unknown>[] = [];

const m = vi.hoisted(() => ({
  changeEventStatus: vi.fn(),
  rescheduleWithoutAvailabilityCheck: vi.fn(),
  runRescheduleSideEffects: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (request: Request, routeCtx: { params: Promise<{ id: string }> }) => {
      const rawBody = await request.text();
      return handler({
        request,
        params: await routeCtx.params,
        body: rawBody ? JSON.parse(rawBody) : null,
        rawBody,
        ctx: CTX,
      });
    },
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/server/event-status-service", () => ({
  changeEventStatus: m.changeEventStatus,
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

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: path === "events/evt1", data: () => eventDoc }),
      set: async (data: Record<string, unknown>) => {
        setCalls.push(data);
        Object.assign(eventDoc, data);
      },
    }),
  }),
}));

const { PATCH } = await import("./route");

function patch(body: unknown) {
  return PATCH(
    new Request("https://example.com/api/v1/events/evt1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "evt1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setCalls.length = 0;
  eventDoc = {
    id: "evt1",
    subAccountId: "sa1",
    mode: "live",
    source: "booking_page",
    bookingPageSlug: "page-a",
    status: "cancelled",
    contactId: "c1",
    startAt: { toDate: () => new Date("2030-01-01T10:00:00Z") },
    endAt: { toDate: () => new Date("2030-01-01T10:30:00Z") },
  };
});

describe("PATCH /api/v1/events/:id — status", () => {
  it("rejects an invalid transition (cancelled -> scheduled) with 409 via the shared service", async () => {
    m.changeEventStatus.mockResolvedValue({
      ok: false,
      httpStatus: 409,
      error: "This event was cancelled — operators can't flip past it.",
    });
    const res = await patch({ status: "scheduled" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_status_transition");
    expect(m.changeEventStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1" }),
      "scheduled",
    );
    // No raw status write happened outside the service.
    expect(setCalls.some((c) => "status" in c)).toBe(false);
  });

  it("applies a valid status change through the service, not a raw write", async () => {
    eventDoc.status = "scheduled";
    m.changeEventStatus.mockResolvedValue({ ok: true, httpStatus: 200, status: "completed" });
    const res = await patch({ status: "completed" });
    expect(res.status).toBe(200);
    expect(m.changeEventStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1" }),
      "completed",
    );
  });
});

describe("PATCH /api/v1/events/:id — reschedule", () => {
  it("routes a real time change on a scheduled booking-page event through the shared reschedule function", async () => {
    eventDoc.status = "scheduled";
    m.rescheduleWithoutAvailabilityCheck.mockResolvedValue({
      event: { ...eventDoc, publicTokenHash: "hash1" },
      newToken: "tok1",
    });
    const res = await patch({ start_at: "2030-01-01T12:00:00Z", end_at: "2030-01-01T12:30:00Z" });
    expect(res.status).toBe(200);
    expect(m.rescheduleWithoutAvailabilityCheck).toHaveBeenCalledWith(
      "evt1",
      new Date("2030-01-01T12:00:00Z"),
      new Date("2030-01-01T12:30:00Z"),
    );
    expect(m.runRescheduleSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "api" }),
    );
    // Not written via the raw merge path.
    expect(setCalls.some((c) => "startAt" in c)).toBe(false);
  });

  it("does NOT stamp/trigger a time patch that doesn't actually change the time", async () => {
    eventDoc.status = "scheduled";
    const res = await patch({ start_at: "2030-01-01T10:00:00Z", end_at: "2030-01-01T10:30:00Z" });
    expect(res.status).toBe(200);
    expect(m.rescheduleWithoutAvailabilityCheck).not.toHaveBeenCalled();
    expect(setCalls.some((c) => "startAt" in c)).toBe(true);
  });

  it("writes a manual event's time as a raw field, no reschedule bookkeeping", async () => {
    eventDoc.source = "manual";
    eventDoc.status = "scheduled";
    const res = await patch({ start_at: "2030-01-01T12:00:00Z", end_at: "2030-01-01T12:30:00Z" });
    expect(res.status).toBe(200);
    expect(m.rescheduleWithoutAvailabilityCheck).not.toHaveBeenCalled();
    expect(setCalls.some((c) => "startAt" in c)).toBe(true);
  });

  it("does not reschedule a cancelled booking-page event's time — raw write instead", async () => {
    eventDoc.status = "cancelled";
    const res = await patch({ start_at: "2030-01-01T12:00:00Z", end_at: "2030-01-01T12:30:00Z" });
    expect(res.status).toBe(200);
    expect(m.rescheduleWithoutAvailabilityCheck).not.toHaveBeenCalled();
    expect(setCalls.some((c) => "startAt" in c)).toBe(true);
  });
});
