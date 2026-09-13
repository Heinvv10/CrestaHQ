import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/v1/events/:id — before the shared event-status-service, this
 * route wrote `status` raw: an API key could un-cancel an event or skip the
 * activity row, trigger and cancel email. Runs the REAL service (only its
 * outbound edges are mocked) so the route→service seam is what's tested:
 * transition refusal, test-mode gating, and post-patch side effects.
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
/** Every write that reached Firestore, route `set` and service `update` alike. */
const writes: Record<string, unknown>[] = [];
let updateThrows: boolean;

const m = vi.hoisted(() => ({
  fireBookingTrigger: vi.fn(),
  recordBookingActivity: vi.fn(),
  sendEmail: vi.fn(),
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
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: m.fireBookingTrigger,
  recordBookingActivity: m.recordBookingActivity,
}));
vi.mock("@/lib/comms/resend", () => ({
  // Configured, so only the mode gate can stop a cancel email.
  emailIsConfigured: () => true,
  sendEmail: m.sendEmail,
  tenantFrom: () => "test@example.com",
}));
vi.mock("@/lib/booking/email", () => ({
  renderBookingCancelledEmail: () => ({ subject: "Cancelled", text: "", html: "" }),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () =>
        path === "events/evt1"
          ? { exists: true, id: "evt1", data: () => ({ ...eventDoc }) }
          : { exists: path === "subAccounts/sa1", data: () => ({ name: "Biz" }) },
      set: async (data: Record<string, unknown>) => {
        writes.push(data);
        Object.assign(eventDoc, data);
      },
    }),
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: name === "contacts",
          data: () => ({ name: `Contact ${id}`, email: `${id}@example.com` }),
        }),
        update: async (patch: Record<string, unknown>) => {
          if (updateThrows) throw new Error("firestore down");
          if (name !== "events" || id !== "evt1") {
            throw new Error(`unexpected update on ${name}/${id}`);
          }
          writes.push(patch);
          Object.assign(eventDoc, patch);
        },
      }),
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

type ErrorBody = { error: { type: string; code: string; message: string } };

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  updateThrows = false;
  CTX.mode = "live";
  // A manual event as events-service / v1 POST store it: no `id` field.
  eventDoc = {
    subAccountId: "sa1",
    agencyId: "ag1",
    mode: "live",
    source: "manual",
    status: "scheduled",
    title: "Call",
    contactId: "c1",
    startAt: { toDate: () => new Date("2030-01-01T10:00:00Z") },
    endAt: { toDate: () => new Date("2030-01-01T10:30:00Z") },
  };
});

describe("PATCH /api/v1/events/:id — status", () => {
  it("refuses cancelled -> scheduled with 409 and writes NOTHING, not even the other fields", async () => {
    eventDoc.status = "cancelled";
    const res = await patch({ status: "scheduled", title: "Renamed" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.type).toBe("invalid_request");
    expect(body.error.code).toBe("invalid_status_transition");
    expect(body.error.message).not.toMatch(/operator/i);
    expect(writes).toEqual([]);
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("applies a valid change on a live event: status written, activity + trigger fired", async () => {
    const res = await patch({ status: "completed" });
    expect(res.status).toBe(200);
    expect(eventDoc.status).toBe("completed");
    expect(m.recordBookingActivity).toHaveBeenCalled();
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "evt1", contactId: "c1" }),
      "event_completed",
    );
  });

  it("control: a live cancel emails the visitor", async () => {
    await patch({ status: "cancelled" });
    expect(m.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "c1@example.com" }),
    );
  });

  it("test-mode key on a test-mode event: status written, no activity, no trigger, no email", async () => {
    CTX.mode = "test";
    eventDoc.mode = "test";
    const res = await patch({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(eventDoc.status).toBe("cancelled");
    expect(m.recordBookingActivity).not.toHaveBeenCalled();
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("changing contact_id and status together notifies and enrols the NEW contact", async () => {
    const res = await patch({ contact_id: "c2", status: "cancelled" });
    expect(res.status).toBe(200);
    expect(m.fireBookingTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "c2" }),
      "event_cancelled",
    );
    expect(m.recordBookingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "c2" }),
      "booking_cancelled",
      expect.anything(),
    );
    expect(m.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "c2@example.com" }),
    );
  });

  it("maps a failed status write to a 500 internal_error, not invalid_request", async () => {
    updateThrows = true;
    const res = await patch({ status: "completed" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.type).toBe("internal_error");
  });
});

describe("PATCH /api/v1/events/:id — time + exposure", () => {
  it("writes start_at/end_at as plain fields", async () => {
    const res = await patch({ start_at: "2030-01-01T12:00:00Z", end_at: "2030-01-01T12:30:00Z" });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].startAt).toEqual(new Date("2030-01-01T12:00:00Z"));
    expect(writes[0].endAt).toEqual(new Date("2030-01-01T12:30:00Z"));
    expect(m.fireBookingTrigger).not.toHaveBeenCalled();
  });

  it("does not expose a booking-page event (it carries no mode)", async () => {
    delete eventDoc.mode;
    eventDoc.source = "booking_page";
    eventDoc.bookingPageSlug = "page-a";
    const res = await patch({ start_at: "2030-01-01T12:00:00Z", end_at: "2030-01-01T12:30:00Z" });
    expect(res.status).toBe(404);
    expect(writes).toEqual([]);
  });
});
