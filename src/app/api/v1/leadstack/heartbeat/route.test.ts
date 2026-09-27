import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mothership heartbeat receiver is unauthenticated by design (buyer
 * deployments hold no shared secret), so a per-IP limit is the only thing
 * standing between a script and an unbounded stream of Firestore writes and
 * new-instance alert emails.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/affiliate/instances-data", () => ({ sendNewInstanceAlert: vi.fn(async () => {}) }));

const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

let n = 0;
const ping = (ip: string) =>
  POST(
    new Request("https://app.test/api/v1/leadstack/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ instanceId: `inst-${++n}`, ownerEmail: "o@example.com" }),
    }),
  );

beforeEach(() => mem.clear());

describe("POST /api/v1/leadstack/heartbeat rate limit", () => {
  it("429s one IP past its hourly budget without writing, while another IP still gets through", async () => {
    for (let i = 0; i < 30; i++) expect((await ping("198.51.100.20")).status).toBe(200);
    const writes = mem.list("leadstackInstances").length;
    const res = await ping("198.51.100.20");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(mem.list("leadstackInstances")).toHaveLength(writes);
    expect((await ping("198.51.100.21")).status).toBe(200);
  });
});

describe("POST /api/v1/leadstack/heartbeat body and instanceId", () => {
  let ip = 0;
  const send = (body: BodyInit, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    POST(
      new Request("https://app.test/api/v1/leadstack/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++ip}`, ...headers },
        body,
        ...init,
      } as RequestInit),
    );
  const payload = (pad: number, instanceId = "inst-ok") =>
    JSON.stringify({ instanceId, ownerEmail: "o@example.com", pad: "x".repeat(pad) });
  const streamOf = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
  const CAP = 16 * 1024;

  it("a normal ping (just under 16 KB) is written", async () => {
    const body = payload(CAP - 200);
    expect(body.length).toBeLessThanOrEqual(CAP);
    expect((await send(body)).status).toBe(200);
    expect(mem.list("leadstackInstances").map((d) => d.id)).toEqual(["inst-ok"]);
  });

  it.each([
    ["a truthful Content-Length", (b: string) => send(b)],
    ["no Content-Length (chunked)", (b: string) => send(streamOf(b), {}, { duplex: "half" } as RequestInit)],
    ["a lying small Content-Length", (b: string) => send(streamOf(b), { "content-length": "20" }, { duplex: "half" } as RequestInit)],
  ])("over 16 KB with %s is a 413 and writes nothing", async (_label, go) => {
    const res = await go(payload(CAP));
    expect(res.status).toBe(413);
    expect(mem.list("leadstackInstances")).toEqual([]);
  });

  it.each(["null", "42", '"text"', "[]"])("a %s JSON body is a 400, not a 500", async (body) => {
    const res = await send(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Body must be a JSON object" });
    expect(mem.list("leadstackInstances")).toEqual([]);
  });

  it.each(["__x__", "a/b", ".."])("instanceId %j is accepted (200) but nothing is written", async (instanceId) => {
    const res = await send(payload(0, instanceId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(mem.all().filter((d) => d.path.startsWith("leadstackInstances"))).toEqual([]);
  });
});
