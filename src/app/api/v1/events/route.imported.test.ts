import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * An API key never sees an event imported from a member's Google Calendar:
 * not in the list, not by id (read, patch, delete), and not as a task's
 * `event_id`. Imported events carry no `mode`, which the queries already
 * filter on; each case is also run with a `mode` stamped on, so that
 * `source` alone keeps the event out.
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
describe.each([
  ["without a mode", {}],
  ["even with a mode stamped on", { mode: "live" }],
])("an imported Google event, %s", (_label, modeField) => {
  beforeEach(() => {
    mem.clear();
    const own = { subAccountId: "sa1", agencyId: "ag1" };
    mem.seed("events/manual", { ...own, mode: "live", title: "Visit", startAt: START, endAt: START });
    mem.seed("events/g1", {
      ...own, ...modeField, source: "google", title: "Dentist", startAt: new Date(START.getTime() + 1), endAt: START,
    });
  });

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
  });

  it("can't be a task's event_id", async () => {
    const res = await tasks.POST(
      new Request("http://x/api/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New", event_id: "g1" }),
      }),
      { params: undefined } as never,
    );
    expect(res.status).toBe(400);
    expect(mem.list("tasks")).toEqual([]);
  });
});
