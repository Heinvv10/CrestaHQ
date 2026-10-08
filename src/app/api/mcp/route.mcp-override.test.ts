import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The per-key `rateLimitPerMinute` override on both MCP charge points:
 * the route's one-token-per-request charge, and the per-tools/call charge
 * inside handleMcpRequest. Same harness as route.mcp-limits.test.ts.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { POST } = await import("./route");
const { mintApiKey } = await import("@/lib/api/keys");

let seq = 0;
function seedKey(extra: Record<string, unknown> = {}) {
  const m = mintApiKey("live");
  mem.seed(`subAccounts/sa1/apiKeys/mo${++seq}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "Agent key", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["agent"],
    revokedAt: null, createdAt: new Date(), ...extra,
  });
  return m.rawKey;
}
const rawPost = (key: string, body: unknown) =>
  POST(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  }));
const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const call = (id: number) => ({
  jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_contacts", arguments: { query: "ann" } },
});

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
});

describe("MCP honours the key doc's rateLimitPerMinute", () => {
  it("route charge: override 200 lets request 61 through; no override refuses it", async () => {
    const raised = seedKey({ rateLimitPerMinute: 200 });
    for (let i = 0; i < 61; i++) expect((await rawPost(raised, list(i))).status).toBe(200);

    const plain = seedKey();
    for (let i = 0; i < 60; i++) expect((await rawPost(plain, list(i))).status).toBe(200);
    expect((await rawPost(plain, list(99))).status).toBe(429);
  });

  it("per-call charge: a 70-call batch runs fully with override 200, and is cut off without one", async () => {
    const batch = Array.from({ length: 70 }, (_, i) => call(i + 1));
    type Out = Array<{ result: { isError?: boolean; structuredContent?: { error?: { code?: string } } } }>;
    const limited = (out: Out) =>
      out.filter((m) => m.result.structuredContent?.error?.code === "rate_limited").length;

    const raised = seedKey({ rateLimitPerMinute: 200 });
    expect(limited((await (await rawPost(raised, batch)).json()) as Out)).toBe(0);

    const plain = seedKey();
    expect(limited((await (await rawPost(plain, batch)).json()) as Out)).toBeGreaterThan(0);
  });
});
