import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Keyless routes take ids from the URL or body and build Firestore paths
 * from them. One that isn't a doc id ("a/b" arrives from "a%2Fb", "..",
 * "__x__") gets the route's own not-found / invalid answer before any read,
 * so a webhook keeps its provider-facing semantics (a 200 "ignored" where a
 * disconnected sub-account would get one).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const SECRET = "keyless-ids-secret-0123456789abcdef";
const BAD = ["a/b", "..", "__x__"];
const SESSION = "0123456789abcdef0123456789abcdef";
type Route = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;

let reads: string[] = [];
const { doc, collection } = mem.db;
beforeAll(() => {
  process.env.VAPI_WEBHOOK_SECRET = SECRET;
});
beforeEach(() => {
  mem.clear();
  reads = [];
  vi.spyOn(mem.db, "doc").mockImplementation((p: string) => (reads.push(p), doc(p)));
  vi.spyOn(mem.db, "collection").mockImplementation((c: string) => (reads.push(c), collection(c)));
});

let ip = 0;
const call = async (handler: unknown, path: string, params: Record<string, string>, body?: unknown) => {
  const init: RequestInit = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=x", "x-forwarded-for": `192.0.2.${++ip % 250}` }, body: JSON.stringify(body) };
  const res = await (handler as Route)(new Request(`http://localhost${path}`, init), { params: Promise.resolve(params) });
  return { status: res.status, body: await res.json() };
};

describe.each(BAD)("id %j", (bad) => {
  it("forms/[id]/submit -> 404, no read", async () => {
    const { POST } = await import("./forms/[id]/submit/route");
    expect(await call(POST, "/f", { id: bad }, { values: {} })).toMatchObject({ status: 404, body: { error: "Form not found" } });
    expect(reads).toEqual([]);
  });

  it("co/[subAccountId]/[slug]/session -> 404, no read", async () => {
    const { POST } = await import("./co/[subAccountId]/[slug]/session/route");
    expect((await call(POST, "/co", { subAccountId: bad, slug: "s" }, {})).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it.each(["capture", "message"])("web-chat/%s sa -> 400, no read", async (route) => {
    const { POST } = await import(`./web-chat/${route}/route`);
    const res = await call(POST, "/wc", {}, { sa: bad, sessionId: SESSION, message: "hi", skip: true });
    expect(res).toMatchObject({ status: 400, body: { error: "Missing sa" } });
    expect(reads).toEqual([]);
  });

  it("web-chat/poll sa -> empty 200, no read", async () => {
    const { GET } = await import("./web-chat/poll/route");
    const res = await call(GET, `/wc?sa=${encodeURIComponent(bad)}&sessionId=${SESSION}`, {});
    expect(res).toMatchObject({ status: 200, body: { messages: [] } });
    expect(reads).toEqual([]);
  });

  it("web-chat/config sa -> 400, no read", async () => {
    const { GET } = await import("./web-chat/config/route");
    expect((await call(GET, `/wc?sa=${encodeURIComponent(bad)}`, {})).status).toBe(400);
    expect(reads).toEqual([]);
  });

  it.each([
    ["stripe", { received: true, ignored: "not_connected" }],
    ["paystack", { received: true, ignored: "not_connected" }],
    ["webinar1", { ok: true, ignored: "not_configured" }],
  ])("webhooks/%s/sa -> the disconnected 200, no read", async (provider, answer) => {
    const { POST } = await import(`./webhooks/${provider}/sa/[subAccountId]/route`);
    expect(await call(POST, "/w", { subAccountId: bad }, {})).toEqual({ status: 200, body: answer });
    expect(reads).toEqual([]);
  });

  it("webhooks/vapi/status: a bad sa or call id is ignored, nothing written", async () => {
    const { POST } = await import("./webhooks/vapi/status/[subAccountId]/route");
    const msg = (id: string) => ({ message: { type: "status-update", status: "ended", call: { id } } });
    expect(await call(POST, `/v?s=${SECRET}`, { subAccountId: bad }, msg("call1"))).toEqual({ status: 200, body: { ok: true, ignored: "invalid id" } });
    expect(await call(POST, `/v?s=${SECRET}`, { subAccountId: "sa1" }, msg(bad))).toEqual({ status: 200, body: { ok: true, ignored: "invalid id" } });
    expect(reads).toEqual([]);
  });

  it("webhooks/vapi/end-of-call: a bad sa or call id is ignored (200, like /status), no read", async () => {
    const { POST } = await import("./webhooks/vapi/end-of-call/[subAccountId]/route");
    const msg = (id: string) => ({ message: { type: "end-of-call-report", call: { id } } });
    expect(await call(POST, `/v?s=${SECRET}`, { subAccountId: bad }, msg("call1"))).toEqual({ status: 200, body: { ok: true, ignored: "invalid id" } });
    expect(await call(POST, `/v?s=${SECRET}`, { subAccountId: "sa1" }, msg(bad))).toEqual({ status: 200, body: { ok: true, ignored: "invalid id" } });
    expect(reads).toEqual([]);
  });

  it("webhooks/vapi/llm sa -> 404, no read", async () => {
    const { POST } = await import("./webhooks/vapi/llm/[subAccountId]/route");
    const res = await call(POST, `/v?s=${SECRET}`, { subAccountId: bad }, { messages: [], stream: false });
    expect(res).toEqual({ status: 404, body: { error: { message: "Sub-account not found" } } });
    expect(reads).toEqual([]);
  });
});

it("a reserved web-chat sessionId (fits the shape, \"__...__\") is refused before any read", async () => {
  const reserved = "__abcdefghijklmn__";
  const { POST } = await import("./web-chat/message/route");
  expect((await call(POST, "/wc", {}, { sa: "sa1", sessionId: reserved, message: "hi" })).status).toBe(400);
  const { GET } = await import("./web-chat/poll/route");
  expect((await call(GET, `/wc?sa=sa1&sessionId=${reserved}`, {})).body).toMatchObject({ messages: [] });
  expect(reads).toEqual([]);
});

it("a real id still reaches Firestore (the guards don't over-refuse)", async () => {
  const { POST } = await import("./webhooks/webinar1/sa/[subAccountId]/route");
  await call(POST, "/w", { subAccountId: "sa1" }, {});
  expect(reads.length).toBeGreaterThan(0);
  reads = [];
  const { GET } = await import("./web-chat/poll/route");
  await call(GET, `/wc?sa=sa1&sessionId=${SESSION}`, {});
  expect(reads).toContain(`subAccounts/sa1/webChatSessions/${SESSION}`);
});
