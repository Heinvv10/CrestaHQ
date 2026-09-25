import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A reservation's heartbeat always stops: when store or release runs (each
 * idempotent), when anything throws after the handler, and after
 * MAX_HOLD_MS for a handler that never settles (breaker PR #265 round 2).
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { withApiAuth } = await import("./auth");
const { mintApiKey } = await import("./keys");

let key = "";
const handler = vi.fn(async (): Promise<NextResponse> => NextResponse.json({}));
const route = withApiAuth(() => handler(), { requireScope: "admin" });
const throwingVeto = withApiAuth(() => handler(), {
  requireScope: "admin",
  cacheIdempotently: (_p, o) => {
    if (o) throw new Error("veto bug");
    return true;
  },
});
const post = (k: string, r = route) =>
  r(
    new Request("http://localhost/api/v1/things", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "idempotency-key": k, "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({}) }
  );
const IDEM = "subAccounts/sa1/apiIdempotency";

beforeEach(() => {
  mem.clear();
  handler.mockReset();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true });
  const m = mintApiKey("live");
  mem.seed("subAccounts/sa1/apiKeys/k1", {
    subAccountId: "sa1", agencyId: "ag1", name: "k", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["admin"], revokedAt: null, createdAt: new Date(),
  });
  key = m.rawKey;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let heartbeat transactions (setImmediate-driven) land between fake-timer steps. */
const settleBeats = () => new Promise((r) => setTimeout(r, 5));

it("N1 a hung handler holds the key for at most MAX_HOLD_MS; after that + the TTL a retry takes over", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const { MAX_HOLD_MS, IN_PROGRESS_TTL_MS, HEARTBEAT_MS } = await import("./idempotency");
  handler.mockImplementationOnce(() => new Promise<NextResponse>(() => {}));
  handler.mockResolvedValue(NextResponse.json({ id: "taken-over" }, { status: 201 }));
  void post("hung");
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  for (let t = 0; t < MAX_HOLD_MS - HEARTBEAT_MS; t += HEARTBEAT_MS) {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await settleBeats();
  }
  expect((await post("hung")).status).toBe(409); // still held just before the ceiling
  for (let t = 0; t < 2 * HEARTBEAT_MS + IN_PROGRESS_TTL_MS; t += HEARTBEAT_MS) {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await settleBeats();
  }
  expect(vi.getTimerCount()).toBe(0);
  const r = await post("hung");
  expect(r.status).toBe(201);
  expect(handler).toHaveBeenCalledTimes(2);
});

it("N2 + S1 cacheIdempotently throwing after the handler SUCCEEDED stops the heartbeat and marks the key done_unknown", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  handler.mockResolvedValue(NextResponse.json({ id: "x" }, { status: 201 }));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(post("leak", throwingVeto)).rejects.toThrow("veto bug");
  expect(vi.getTimerCount()).toBe(0);
  expect(mem.list(IDEM)).toMatchObject([{ state: "done_unknown" }]);
  expect((mem.list(IDEM)[0].expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  expect(err).toHaveBeenCalledWith(expect.stringContaining("key marked done_unknown"));
  for (const _retry of [1, 2]) {
    const r = await post("leak", throwingVeto);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("outcome_unknown");
  }
  expect(handler).toHaveBeenCalledTimes(1);
});

it("store and release each stop the heartbeat, and are idempotent", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { reserveIdempotencyKey } = await import("./idempotency");
  const a = await reserveIdempotencyKey("sa1", "live", "k1", "t-store", "fp");
  if (a.kind !== "reserved") throw new Error(a.kind);
  expect(vi.getTimerCount()).toBe(1);
  await a.store({ status: 201, bodyJson: { id: 1 } });
  expect(vi.getTimerCount()).toBe(0);
  await a.release(); // a second settle is a no-op: the stored outcome stays
  expect(mem.list(IDEM)).toMatchObject([{ state: "done", status: 201 }]);

  const b = await reserveIdempotencyKey("sa1", "live", "k1", "t-release", "fp");
  if (b.kind !== "reserved") throw new Error(b.kind);
  expect(vi.getTimerCount()).toBe(1);
  await b.release();
  expect(vi.getTimerCount()).toBe(0);
  await b.store({ status: 201, bodyJson: { id: 2 } }); // no-op after release
  expect(mem.list(IDEM)).toHaveLength(1);
});

it("a second store after one that ended in done_unknown is a no-op", async () => {
  const { reserveIdempotencyKey } = await import("./idempotency");
  const r = await reserveIdempotencyKey("sa1", "live", "k1", "twice", "fp");
  if (r.kind !== "reserved") throw new Error(r.kind);
  const orig = mem.db.runTransaction.bind(mem.db);
  let n = 0;
  vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: never) =>
    ++n <= 3 ? Promise.reject(new Error("14 UNAVAILABLE")) : orig(fn)) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  await r.store({ status: 201, bodyJson: { id: 1 } });
  expect(mem.list(IDEM)).toMatchObject([{ state: "done_unknown" }]);
  await r.store({ status: 201, bodyJson: { id: 1 } });
  expect(mem.list(IDEM)).toMatchObject([{ state: "done_unknown" }]);
});
