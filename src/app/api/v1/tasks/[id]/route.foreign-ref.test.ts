import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * PATCH /api/v1/tasks/:id and PATCH /api/v1/events/:id re-link a record by
 * `contact_id` (and, for tasks, `deal_id` / `event_id`). The linked record
 * must be in the key's sub-account AND mode — the same rule the create
 * routes apply. A foreign id is a 404 and the record is left untouched.
 * POST /api/v1/tasks checked `contact_id` but not `deal_id` / `event_id`.
 */

const mem = createMemoryFirestore();
const CTX = {
  agencyId: "ag1", subAccountId: "sa1", keyId: "key1", keyPrefix: "lsk_abcd",
  mode: "live" as const, scopes: ["admin"], requestId: "req_test", apiVersion: "2026-01-01",
};
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (request: Request, routeCtx: { params: Promise<{ id: string }> }) => {
      const rawBody = await request.text();
      return handler({
        request, params: await routeCtx.params,
        body: rawBody ? JSON.parse(rawBody) : null, rawBody, ctx: CTX,
      });
    },
}));

const tasks = await import("./route");
const tasksCollection = await import("../route");
const events = await import("../../events/[id]/route");

const patch = (
  handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: string,
  body: unknown,
) =>
  handler(
    new Request(`http://x/api/v1/x/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  mem.clear();
  const own = { subAccountId: "sa1", agencyId: "ag1", mode: "live" };
  mem.seed("contacts/c1", { ...own, name: "Ann" });
  mem.seed("contacts/c2", { ...own, name: "Ben" });
  mem.seed("contacts/cB", { subAccountId: "saB", agencyId: "ag1", mode: "live" });
  mem.seed("contacts/cTest", { ...own, mode: "test" });
  mem.seed("deals/d1", own);
  mem.seed("deals/dB", { subAccountId: "saB", agencyId: "ag1", mode: "live" });
  mem.seed("events/e1", { ...own, title: "Visit", contactId: "c1" });
  mem.seed("events/eB", { subAccountId: "saB", agencyId: "ag1", mode: "live" });
  mem.seed("tasks/t1", { ...own, title: "Call", contactId: "c1", dealId: null, eventId: null });
});

it.each([
  ["contact_id", { contact_id: "cB" }],
  ["contact_id (other mode)", { contact_id: "cTest" }],
  ["deal_id", { deal_id: "dB" }],
  ["event_id", { event_id: "eB" }],
])("task PATCH refuses a foreign %s with 404, task untouched", async (_l, body) => {
  const res = await patch(tasks.PATCH, "t1", { ...body, title: "Changed" });
  expect(res.status).toBe(404);
  expect(mem.read("tasks/t1")).toMatchObject({ title: "Call", contactId: "c1", dealId: null, eventId: null });
});

it("task PATCH accepts own records and null unlinks", async () => {
  expect((await patch(tasks.PATCH, "t1", { contact_id: "c2", deal_id: "d1", event_id: "e1" })).status).toBe(200);
  expect(mem.read("tasks/t1")).toMatchObject({ contactId: "c2", dealId: "d1", eventId: "e1" });
  expect((await patch(tasks.PATCH, "t1", { contact_id: null })).status).toBe(200);
  expect(mem.read("tasks/t1")?.contactId).toBeNull();
});

it.each([["cB"], ["cTest"]])("event PATCH refuses contact_id=%s with 404, event untouched", async (cid) => {
  const res = await patch(events.PATCH, "e1", { contact_id: cid, title: "Changed" });
  expect(res.status).toBe(404);
  expect(mem.read("events/e1")).toMatchObject({ title: "Visit", contactId: "c1" });
});

it("event PATCH accepts the sub-account's own contact", async () => {
  expect((await patch(events.PATCH, "e1", { contact_id: "c2" })).status).toBe(200);
  expect(mem.read("events/e1")?.contactId).toBe("c2");
});

it.each([
  ["deal_id", { deal_id: "dB" }],
  ["event_id", { event_id: "eB" }],
])("task POST refuses a foreign %s and creates nothing", async (_l, body) => {
  const res = await tasksCollection.POST(
    new Request("http://x/api/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New", ...body }),
    }),
    { params: Promise.resolve({}) } as never,
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toMatch(/_not_found$/);
  expect(mem.list("tasks").map((t) => t.id)).toEqual(["t1"]);
});
