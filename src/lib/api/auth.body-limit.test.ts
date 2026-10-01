import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * withApiAuth caps the request body (MAX_BODY_BYTES; the agent tools route
 * MAX_AGENT_BODY_BYTES): over it is a 413 body_too_large, the handler never
 * runs, whether the size is declared truthfully, not at all, or too small.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { withApiAuth } = await import("./auth");
const { mintApiKey } = await import("./keys");
const { MAX_BODY_BYTES, MAX_AGENT_BODY_BYTES } = await import("./body-limit");

let key = "";
const handler = vi.fn(async (): Promise<NextResponse> => NextResponse.json({ ok: true }));
const route = withApiAuth(() => handler(), { requireScope: "admin" });
const agentSized = withApiAuth(() => handler(), { requireScope: "admin", maxBodyBytes: MAX_AGENT_BODY_BYTES });

/** A JSON string literal body of exactly `size` bytes. */
const jsonOf = (size: number) => `"${"x".repeat(size - 2)}"`;

function chunked(text: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 16_384) c.enqueue(bytes.slice(i, i + 16_384));
      c.close();
    },
  });
  return { body, headers, duplex: "half" } as RequestInit;
}

const send = (r: typeof route, init: RequestInit) =>
  r(
    new Request("http://localhost/api/v1/things", {
      method: "POST",
      ...init,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
    }),
    { params: undefined },
  );

beforeEach(() => {
  mem.clear();
  handler.mockClear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true });
  const m = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/k1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["admin"], revokedAt: null, createdAt: new Date(),
  });
  key = m.rawKey;
});

async function expect413(res: Response) {
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ error: { type: "invalid_request", code: "body_too_large" } });
  expect(handler).not.toHaveBeenCalled();
}

describe("withApiAuth body cap (256 KB)", () => {
  it("an at-cap body reaches the handler", async () => {
    expect((await send(route, { body: jsonOf(MAX_BODY_BYTES) })).status).toBe(200);
    expect((await send(route, chunked(jsonOf(MAX_BODY_BYTES)))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("over the cap with a truthful Content-Length -> 413", async () => {
    await expect413(await send(route, { body: jsonOf(MAX_BODY_BYTES + 1) }));
  });

  it("over the cap, chunked with no Content-Length -> 413", async () => {
    await expect413(await send(route, chunked(jsonOf(MAX_BODY_BYTES + 1))));
  });

  it("over the cap under a lying small Content-Length -> 413", async () => {
    await expect413(await send(route, chunked(jsonOf(MAX_BODY_BYTES + 1), { "content-length": "2" })));
  });

  it("the 413 is logged without the body", async () => {
    await send(route, chunked(jsonOf(MAX_BODY_BYTES + 1)));
    await new Promise((r) => setTimeout(r, 20));
    // (the previous test's un-awaited log may land here too; both are 413s)
    const logs = mem.list("subAccounts/sa1/apiRequestLogs");
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).toMatchObject({ responseStatus: 413, errorCode: "body_too_large", requestBody: "" });
  });
});

describe("the agent-sized cap (1 MiB)", () => {
  it("takes a body over 256 KB, refuses one over 1 MiB", async () => {
    expect((await send(agentSized, { body: jsonOf(MAX_BODY_BYTES + 1) })).status).toBe(200);
    expect((await send(agentSized, { body: jsonOf(MAX_AGENT_BODY_BYTES) })).status).toBe(200);
    handler.mockClear();
    await expect413(await send(agentSized, chunked(jsonOf(MAX_AGENT_BODY_BYTES + 1))));
  });
});

describe("POST /api/v1/tools/{name} takes the agent-sized cap", () => {
  // The cap is checked before the scope, so an admin key shows which cap applies:
  // 403 insufficient_scope past the 256 KB default, 413 past 1 MiB.
  it("a 300 KB body passes the cap; one over 1 MiB doesn't", async () => {
    const { POST } = await import("@/app/api/v1/tools/[name]/route");
    const tool = (body: string) =>
      POST(
        new Request("http://localhost/api/v1/tools/create_contact", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body,
        }),
        { params: Promise.resolve({ name: "create_contact" }) },
      );
    expect(await (await tool(jsonOf(300 * 1024))).json()).toMatchObject({ error: { code: "insufficient_scope" } });
    expect(await (await tool(jsonOf(MAX_AGENT_BODY_BYTES + 1))).json()).toMatchObject({ error: { code: "body_too_large" } });
  });
});
