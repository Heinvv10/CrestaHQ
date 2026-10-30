import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A body id that reaches `db.doc` (contact_id, deal_id, event_id,
 * pipeline_id, prospecting.list_id) must be a doc id: anything else is 400
 * invalid_id and nothing is written. "c1/sub/s1" would address a
 * subcollection doc that carries the parent's subAccountId and mode; ".."
 * and "__x__" make Firestore throw (a 500 before this).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { mintApiKey } = await import("@/lib/api/keys");
const tasks = await import("./tasks/route");
const task = await import("./tasks/[id]/route");
const deals = await import("./deals/route");
const events = await import("./events/route");
const event = await import("./events/[id]/route");
const contact = await import("./contacts/[id]/route");
const recipients = await import("./links/[id]/recipients/route");

const BAD = ["c1/sub/s1", "..", "__x__"];
const own = { subAccountId: "sa1", agencyId: "ag1", mode: "live" };
type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
let key = "";
let n = 0;

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, prospectingEnabledByAgency: true });
  const m = mintApiKey("live");
  mem.seed(`subAccounts/sa1/apiKeys/k${++n}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["admin"], revokedAt: null, createdAt: new Date(),
  });
  key = m.rawKey;
  for (const c of ["contacts", "deals", "events"]) mem.seed(`${c}/c1/sub/s1`, own);
  mem.seed("contacts/c1", { ...own, name: "Ann" });
  mem.seed("tasks/t1", { ...own, title: "Call", contactId: null, dealId: null, eventId: null });
  mem.seed("events/e1", { ...own, title: "Visit", contactId: null });
});

const call = (h: unknown, method: string, body: unknown, params: Record<string, string> = {}) =>
  (h as Handler)(
    new Request("http://localhost/api/v1/x", {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );

async function expectInvalidId(res: Response, field: string) {
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { type: "invalid_request", code: "invalid_id", message: `\`${field}\` is not a valid id.` } });
}

const docsIn = (c: string) => mem.list(c).map((d) => d.id).sort();
const start = new Date(Date.now() + 86_400_000);
const end = new Date(start.getTime() + 3_600_000);

describe.each(BAD)("bad id %j", (bad) => {
  it.each(["contact_id", "deal_id", "event_id"])("POST /tasks %s -> 400, no task", async (field) => {
    await expectInvalidId(await call(tasks.POST, "POST", { title: "T", [field]: bad }), field);
    expect(docsIn("tasks")).toEqual(["t1"]);
  });

  it.each(["contact_id", "deal_id", "event_id"])("PATCH /tasks/:id %s -> 400, unchanged", async (field) => {
    await expectInvalidId(await call(task.PATCH, "PATCH", { [field]: bad }, { id: "t1" }), field);
    expect(mem.read("tasks/t1")).toMatchObject({ contactId: null, dealId: null, eventId: null });
  });

  it.each([
    ["contact_id", { contact_id: bad }],
    ["pipeline_id", { contact_id: "c1", pipeline_id: bad }],
    ["assigned_to_uid", { contact_id: "c1", assigned_to_uid: bad }],
  ])("POST /deals %s -> 400, no deal", async (field, extra) => {
    await expectInvalidId(await call(deals.POST, "POST", { title: "D", value: 10, currency: "USD", stage: "new", ...extra }), field);
    expect(docsIn("deals")).toEqual([]);
  });

  it("POST /events contact_id -> 400, no event", async () => {
    const body = { title: "E", start_at: start.toISOString(), end_at: end.toISOString(), contact_id: bad };
    await expectInvalidId(await call(events.POST, "POST", body), "contact_id");
    expect(docsIn("events")).toEqual(["e1"]);
  });

  it("PATCH /events/:id contact_id -> 400, unchanged", async () => {
    await expectInvalidId(await call(event.PATCH, "PATCH", { contact_id: bad }, { id: "e1" }), "contact_id");
    expect(mem.read("events/e1")).toMatchObject({ contactId: null });
  });

  it("POST /links/:id/recipients contact_id -> 400, no recipient", async () => {
    mem.seed("trackedLinks/l1", { ...own, destinationUrl: "https://example.com" });
    await expectInvalidId(await call(recipients.POST, "POST", { contact_id: bad }, { id: "l1" }), "contact_id");
    expect(mem.list("trackedLinks/l1/recipients")).toEqual([]);
  });

  it("PATCH /contacts/:id prospecting.list_id -> 400, unchanged", async () => {
    await expectInvalidId(await call(contact.PATCH, "PATCH", { prospecting: { list_id: bad } }, { id: "c1" }), "prospecting.list_id");
    expect(mem.read("contacts/c1")).toEqual({ ...own, name: "Ann" });
  });
});

it("a missing links contact_id stays invalid_body", async () => {
  mem.seed("trackedLinks/l1", { ...own, destinationUrl: "https://example.com" });
  const res = await call(recipients.POST, "POST", {}, { id: "l1" });
  expect(await res.json()).toMatchObject({ error: { code: "invalid_body" } });
});

it("good ids still link", async () => {
  expect((await call(tasks.POST, "POST", { title: "T", contact_id: "c1" })).status).toBe(201);
  expect((await call(task.PATCH, "PATCH", { contact_id: "c1" }, { id: "t1" })).status).toBe(200);
  expect(mem.read("tasks/t1")).toMatchObject({ contactId: "c1" });
});
