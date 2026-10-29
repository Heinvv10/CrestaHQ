import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * An API key never sees an event imported from a member's Google Calendar:
 * not in the list, not by id (read, patch, delete), and not as a task's
 * `event_id`. The importer writes no `mode`, and the list and by-id routes
 * already filter on it — so those cases stamp the key's mode on, leaving
 * `source` as the only thing that keeps the event out. A task link is
 * checked both ways: refInSubAccount accepts any mode-less event (bookings
 * carry none), so there `source` decides even without a mode.
 */

const mem = createMemoryFirestore();
const CTX = {
  agencyId: "ag1", subAccountId: "sa1", keyId: "key1", keyPrefix: "lsk_abcd",
  mode: "live" as const, scopes: ["admin"], requestId: "req_test", apiVersion: "2026-01-01",
};
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/google-calendar/push", () => ({ removeBookingFromGoogleBeforeDelete: async () => ({ ok: true }) }));
vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (request: Request, routeCtx: { params?: Promise<{ id: string }> }) => {
      const rawBody = await request.text();
      return handler({
        request, params: await routeCtx.params,
        body: rawBody ? JSON.parse(rawBody) : null, rawBody, ctx: CTX,
      });
    },
}));

const list = await import("./route");
const byId = await import("./[id]/route");
const tasks = await import("../tasks/route");

const call = (
  handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>,
  method: string,
  id: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://x/api/v1/events/${id}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  );

const START = new Date("2026-09-20T09:00:00Z");
const own = { subAccountId: "sa1", agencyId: "ag1" };
const seedImported = (extra: Record<string, unknown>) => {
  mem.clear();
  mem.seed("events/manual", { ...own, mode: "live", title: "Visit", startAt: START, endAt: START });
  mem.seed("events/booking", { ...own, title: "Booked", source: "booking_page", startAt: START, endAt: START });
  mem.seed("events/g1", {
    ...own, ...extra, source: "google", importOwnerUid: "u1", title: "Dentist", startAt: new Date(START.getTime() + 1), endAt: START,
  });
};
const postTask = (eventId: string) =>
  tasks.POST(
    new Request("http://x/api/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New", event_id: eventId }),
    }),
    { params: undefined } as never,
  );

describe("an imported Google event stamped with the key's mode", () => {
  beforeEach(() => seedImported({ mode: "live" }));

  it("is not listed", async () => {
    const res = await list.GET(new Request("http://x/api/v1/events?limit=20"), { params: undefined } as never);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((e) => e.id)).toEqual(["manual"]);
  });

  it("is not found by id: read, patch or delete", async () => {
    expect((await call(byId.GET, "GET", "g1")).status).toBe(404);
    expect((await call(byId.PATCH, "PATCH", "g1", { title: "Changed" })).status).toBe(404);
    expect(mem.read("events/g1")?.title).toBe("Dentist");
    expect((await call(byId.DELETE, "DELETE", "g1")).status).toBe(404);
    expect(mem.read("events/g1")).toBeDefined();
    expect((await call(byId.GET, "GET", "manual")).status).toBe(200);
  });

  it("can't be a task's event_id", async () => {
    expect((await postTask("g1")).status).toBe(400);
    expect(mem.list("tasks")).toEqual([]);
  });
});

describe("an imported Google event as the importer writes it (no mode)", () => {
  beforeEach(() => seedImported({}));

  it("can't be a task's event_id, though a mode-less booking can", async () => {
    expect((await postTask("g1")).status).toBe(400);
    expect(mem.list("tasks")).toEqual([]);
    expect((await postTask("booking")).status).toBe(201);
  });
});
