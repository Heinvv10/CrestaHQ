import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The breaker's PR #265 repros, as regression tests: concurrency, a live
 * handler slower than the reservation TTL (heartbeat), a lost outcome store
 * (retry, then a done_unknown marker), tenancy scoping and legacy docs.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { withApiAuth } = await import("./auth");
const { mintApiKey } = await import("./keys");
const { fingerprintRequest } = await import("./idempotency");

let key = "";
let key2 = "";
let keyB = "";
const handler = vi.fn(async (): Promise<NextResponse> => NextResponse.json({}));
const route = withApiAuth(() => handler(), { requireScope: "admin" });
const post = (k: string, body = "{}", bearer = key) =>
  route(
    new Request("http://localhost/api/v1/things", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "idempotency-key": k, "content-type": "application/json" },
      body,
    }),
    { params: Promise.resolve({}) }
  );
const IDEM = "subAccounts/sa1/apiIdempotency";
const codeOf = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

const seedKey = (sa: string, id: string) => {
  const m = mintApiKey("live");
  mem.seed(`subAccounts/${sa}/apiKeys/${id}`, {
    subAccountId: sa, agencyId: "ag1", name: "k", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["admin"], revokedAt: null, createdAt: new Date(),
  });
  return m.rawKey;
};

beforeEach(() => {
  mem.clear();
  handler.mockReset();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", apiAccessEnabledByAgency: true });
  key = seedKey("sa1", "k1");
  key2 = seedKey("sa1", "k2");
  keyB = seedKey("sa2", "kb");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const expiresAtOf = () => (mem.list(IDEM)[0]?.expiresAt as Date).getTime();
/** Make db.runTransaction reject on the given call numbers (1-based). */
const failTransactions = (calls: number[]) => {
  const orig = mem.db.runTransaction.bind(mem.db);
  let n = 0;
  return vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: never) =>
    calls.includes(++n) ? Promise.reject(new Error("14 UNAVAILABLE")) : orig(fn)) as never);
};

it("B1 10 parallel requests -> handler once", async () => {
  handler.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return NextResponse.json({ id: "c1" }, { status: 201 });
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => post("par-10")));
  expect(handler).toHaveBeenCalledTimes(1);
  const s = results.map((r) => r.status);
  expect(s.filter((x) => x === 201)).toHaveLength(1);
  expect(s.filter((x) => x === 409)).toHaveLength(9);
});

it("B2 a LIVE handler slower than 60s keeps its reservation by heartbeat: a retry at 61s is in_progress, run once", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  let finish = () => {};
  handler.mockImplementationOnce(
    () => new Promise((r) => (finish = () => r(NextResponse.json({ id: "first" }, { status: 201 }))))
  );
  handler.mockResolvedValue(NextResponse.json({ id: "second" }, { status: 201 }));
  const first = post("slow");
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(61_000);
  await vi.waitFor(() => expect(expiresAtOf()).toBeGreaterThan(Date.now()));
  const retry = await post("slow");
  expect(retry.status).toBe(409);
  expect(await codeOf(retry)).toBe("idempotency_in_progress");
  finish();
  expect((await first).status).toBe(201);
  expect(handler).toHaveBeenCalledTimes(1);
});

it("a failed heartbeat is logged and the handler still completes", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  let finish = () => {};
  handler.mockImplementationOnce(
    () => new Promise((r) => (finish = () => r(NextResponse.json({ id: "hb" }, { status: 201 }))))
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const first = post("hb-fail");
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  const spy = failTransactions([1]);
  await vi.advanceTimersByTimeAsync(20_000);
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[api/v1] idempotency heartbeat failed", expect.any(Error)));
  spy.mockRestore();
  finish();
  expect((await first).status).toBe(201);
});

it("B3 handler succeeds, one store attempt fails: the retried store keeps the outcome, a retry at 61s replays", async () => {
  handler.mockResolvedValue(NextResponse.json({ id: "c3" }, { status: 201 }));
  failTransactions([2]);
  expect((await post("lost")).status).toBe(201);
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  const late = await post("lost");
  expect(late.status).toBe(201);
  expect(await late.json()).toMatchObject({ id: "c3" });
  expect(handler).toHaveBeenCalledTimes(1);
});

it("the store failing every attempt marks the key done_unknown: a retry at 61s gets outcome_unknown, never re-runs", async () => {
  handler.mockResolvedValue(NextResponse.json({ id: "c3" }, { status: 201 }));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  failTransactions([2, 3, 4]);
  expect((await post("lost-all")).status).toBe(201);
  vi.restoreAllMocks();
  expect(err).toHaveBeenCalledWith(expect.stringContaining("marked done_unknown"), expect.any(Error));
  expect(mem.list(IDEM)[0]).toMatchObject({ state: "done_unknown" });
  expect(expiresAtOf()).toBeGreaterThan(Date.now() + 23 * 3600_000); // the stored-outcome TTL
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  const late = await post("lost-all");
  expect(late.status).toBe(409);
  expect(await codeOf(late)).toBe("outcome_unknown");
  expect(handler).toHaveBeenCalledTimes(1);
});

it("the done_unknown marker failing too is logged; the reservation then expires as before", async () => {
  handler.mockResolvedValue(NextResponse.json({ id: "c3" }, { status: 201 }));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  failTransactions([2, 3, 4, 5]);
  expect((await post("lost-marker")).status).toBe(201);
  vi.restoreAllMocks();
  expect(err).toHaveBeenCalledWith(expect.stringContaining("marker both failed"), expect.any(Error), expect.any(Error));
  expect((await post("lost-marker")).status).toBe(409);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 61_000);
  expect((await post("lost-marker")).status).toBe(201);
  expect(handler).toHaveBeenCalledTimes(2);
});

it("B4 crash then concurrent retries: exactly one re-run", async () => {
  handler.mockRejectedValueOnce(new Error("boom"));
  handler.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return NextResponse.json({ id: "c4" }, { status: 201 });
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await post("crash")).status).toBe(500);
  err.mockRestore();
  const rs = await Promise.all([post("crash"), post("crash"), post("crash")]);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
});

it("B5 same key string, other sub-account: runs independently, never replays sa1's body", async () => {
  handler.mockResolvedValueOnce(NextResponse.json({ id: "sa1-secret" }, { status: 201 }));
  handler.mockResolvedValueOnce(NextResponse.json({ id: "sa2" }, { status: 201 }));
  await post("shared");
  const b = await post("shared", "{}", keyB);
  expect(await b.json()).toMatchObject({ id: "sa2" });
  expect(handler).toHaveBeenCalledTimes(2);
});

it("B6 same sub-account, second API key, same key+body: runs the action again (key-scoped, not sub-account scoped)", async () => {
  handler.mockResolvedValue(NextResponse.json({ id: "x" }, { status: 201 }));
  await post("dup-keys");
  await post("dup-keys", "{}", key2);
  expect(handler).toHaveBeenCalledTimes(2); // documents current behaviour
});

it("B7 legacy done record (no state field) replays; a record without a numeric status is treated as absent", async () => {
  const fp = fingerprintRequest("POST", "/api/v1/things", "{}");
  handler.mockResolvedValue(NextResponse.json({ id: "fresh" }, { status: 201 }));
  await post("legacy");
  const [doc] = mem.list(IDEM);
  mem.seed(`${IDEM}/${doc.id}`, { status: 201, bodyJson: { id: "old" }, requestFingerprint: fp, mode: "live", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) });
  const r = await post("legacy");
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({ id: "old" });
  mem.seed(`${IDEM}/${doc.id}`, { requestFingerprint: fp, expiresAt: new Date(Date.now() + 3600_000) });
  const r2 = await post("legacy");
  expect(r2.status).toBe(201);
  expect(await r2.json()).toMatchObject({ id: "fresh" });
  expect(handler).toHaveBeenCalledTimes(2);
});

it("B8 fake fidelity: two reservations interleaved at the read, only one commits", async () => {
  const { reserveIdempotencyKey } = await import("./idempotency");
  const orig = mem.db.runTransaction.bind(mem.db);
  let gate!: () => void;
  const barrier = new Promise<void>((r) => (gate = r));
  let reads = 0;
  type Tx = { get: (ref: unknown) => Promise<unknown> };
  vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: (tx: Tx) => Promise<unknown>) =>
    orig(async (tx) => {
      const get = tx.get.bind(tx);
      tx.get = (async (ref: Parameters<typeof get>[0]) => {
        const s = await get(ref);
        if (++reads === 2) gate();
        await barrier;
        return s;
      }) as typeof tx.get;
      return fn(tx as unknown as Tx);
    })) as never);
  const [a, b] = await Promise.all([
    reserveIdempotencyKey("sa1", "live", "k1", "ilv", "fp"),
    reserveIdempotencyKey("sa1", "live", "k1", "ilv", "fp"),
  ]);
  expect([a.kind, b.kind].sort()).toEqual(["in_progress", "reserved"]);
});
