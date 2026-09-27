import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A v1 route param or `starting_after` cursor that isn't a doc id is a 400
 * before any read of the resource. Next decodes %2F inside a route param
 * (proved below with Next's own matcher), so without the check
 * `/api/v1/contacts/c1%2Fsub%2Fs1` reads `contacts/c1/sub/s1`: a
 * subcollection doc that carries the parent's subAccountId and mode.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { mintApiKey } = await import("@/lib/api/keys");
const contact = await import("./contacts/[id]/route");
const deal = await import("./deals/[id]/route");
const event = await import("./events/[id]/route");
const task = await import("./tasks/[id]/route");
const recipients = await import("./links/[id]/recipients/route");
const submissions = await import("./forms/[formId]/submissions/route");
const lists = {
  contacts: await import("./contacts/route"),
  deals: await import("./deals/route"),
  events: await import("./events/route"),
  tasks: await import("./tasks/route"),
};

const BAD = ["c1/sub/s1", "..", "__x__"];
const own = { subAccountId: "sa1", agencyId: "ag1", mode: "live" };
type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;

const { doc, collection } = mem.db; // the originals, before any spy wraps them
let n = 0;
const keys: Record<string, string> = {};
/** Resource paths read through db.doc / db.collection during a request. */
let touched: string[] = [];

function seedKey(scope: string) {
  const m = mintApiKey("live");
  mem.seed(`subAccounts/sa1/apiKeys/k${++n}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: [scope], revokedAt: null, createdAt: new Date(),
  });
  keys[scope] = m.rawKey;
}

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true });
  seedKey("admin");
  seedKey("forms-ingest");
  for (const c of ["contacts", "deals", "events", "tasks", "trackedLinks", "forms"]) {
    mem.seed(`${c}/c1`, own);
    mem.seed(`${c}/c1/sub/s1`, own); // what "c1%2Fsub%2Fs1" would address
  }
  touched = [];
  vi.spyOn(mem.db, "doc").mockImplementation((p: string) => {
    if (!p.startsWith("subAccounts/")) touched.push(p);
    return doc(p);
  });
  vi.spyOn(mem.db, "collection").mockImplementation((c: string) => {
    if (c !== "subAccounts") touched.push(c);
    return collection(c);
  });
});

const call = (h: unknown, method: string, url: string, params: Record<string, string>, scope = "admin") =>
  (h as Handler)(
    new Request(`http://localhost${url}`, {
      method,
      headers: { authorization: `Bearer ${keys[scope]}`, "content-type": "application/json" },
      ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify({ contact_id: "c1", values: {} }) }),
    }),
    { params: Promise.resolve(params) },
  );

async function expectRefused(res: Response, code: string) {
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { type: "invalid_request", code } });
  expect(touched).toEqual([]);
  expect(mem.read("contacts/c1/sub/s1")).toBeDefined(); // a DELETE never reached it
}

it("Next decodes %2F inside a route param (why the check is needed)", async () => {
  const { getRouteRegex } = await import("next/dist/shared/lib/router/utils/route-regex");
  const { getRouteMatcher } = await import("next/dist/shared/lib/router/utils/route-matcher");
  const match = getRouteMatcher(getRouteRegex("/api/v1/contacts/[id]"));
  expect(match("/api/v1/contacts/c1%2Fsub%2Fs1")).toEqual({ id: "c1/sub/s1" });
});

describe.each([
  ["contacts", contact],
  ["deals", deal],
  ["events", event],
  ["tasks", task],
] as const)("/api/v1/%s/:id", (name, mod) => {
  it.each(["GET", "PATCH", "DELETE"] as const)("%s with a bad id -> 400 invalid_id, no read", async (method) => {
    for (const id of BAD) {
      touched = [];
      await expectRefused(await call(mod[method], method, `/api/v1/${name}/x`, { id }), "invalid_id");
    }
  });
});

it("POST /api/v1/links/:id/recipients with a bad id -> 400, no read", async () => {
  for (const id of BAD) {
    touched = [];
    await expectRefused(await call(recipients.POST, "POST", "/api/v1/links/x/recipients", { id }), "invalid_id");
  }
});

it("POST /api/v1/forms/:formId/submissions with a bad id -> 400, no read", async () => {
  for (const formId of BAD) {
    touched = [];
    await expectRefused(await call(submissions.POST, "POST", "/api/v1/forms/x/submissions", { formId }, "forms-ingest"), "invalid_id");
  }
});

describe.each(Object.entries(lists))("GET /api/v1/%s?starting_after=", (name, mod) => {
  it("a bad cursor -> 400 invalid_cursor, no cursor read", async () => {
    for (const id of BAD) {
      touched = [];
      const res = await call(mod.GET, "GET", `/api/v1/${name}?starting_after=${encodeURIComponent(id)}`, {});
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_cursor" } });
      expect(touched.filter((p) => p.includes("/"))).toEqual([]);
    }
  });

  it("a good cursor still pages", async () => {
    mem.seed(`${name}/c1`, { ...own, createdAt: new Date(), startAt: new Date() });
    expect((await call(mod.GET, "GET", `/api/v1/${name}?starting_after=c1`, {})).status).toBe(200);
  });
});

it("a good id still reaches the route", async () => {
  mem.seed("contacts/c1", { ...own, name: "Ann", createdAt: new Date() });
  expect((await call(contact.GET, "GET", "/api/v1/contacts/c1", { id: "c1" })).status).toBe(200);
});
