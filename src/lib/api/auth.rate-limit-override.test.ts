import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The per-key `rateLimitPerMinute` override, through the real seam: key doc
 * -> getApiKey read -> auth context -> checkAndCount -> X-RateLimit-* headers.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { withApiAuth } = await import("./auth");
const { mintApiKey } = await import("./keys");

const route = withApiAuth(async () => NextResponse.json({ ok: true }), { requireScope: "admin" });

let seq = 0;
function seedKey(extra: Record<string, unknown> = {}) {
  const m = mintApiKey("live");
  mem.seed(`subAccounts/sa1/apiKeys/rl${++seq}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["admin"],
    revokedAt: null, createdAt: new Date(), ...extra,
  });
  return m.rawKey;
}
const send = (key: string) =>
  route(
    new Request("http://localhost/api/v1/things", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: "{}",
    }),
    { params: undefined },
  );

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true });
});

describe("withApiAuth honours the key doc's rateLimitPerMinute", () => {
  it("override 300: the 61st request is accepted and the header reports 300", async () => {
    const key = seedKey({ rateLimitPerMinute: 300 });
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await send(key);
      expect(last.status).toBe(200);
    }
    expect(last!.headers.get("X-RateLimit-Limit")).toBe("300");
    expect(last!.headers.get("X-RateLimit-Remaining")).toBe("239");
  });

  it("no override: the 61st request is a 429 reporting a limit of 60", async () => {
    const key = seedKey();
    for (let i = 0; i < 60; i++) expect((await send(key)).status).toBe(200);
    const res = await send(key);
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it("an out-of-range doc value is clamped to 600 end to end", async () => {
    const res = await send(seedKey({ rateLimitPerMinute: 100000 }));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("600");
  });
});
