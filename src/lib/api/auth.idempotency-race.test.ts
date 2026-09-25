import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * withApiAuth reserves an Idempotency-Key BEFORE the handler runs, so N
 * concurrent requests with one key run the handler once. The reservation is
 * handed back when the outcome is not stored (or the handler throws), and a
 * stale one is taken over.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { withApiAuth } = await import("./auth");
const { mintApiKey } = await import("./keys");
const { fingerprintRequest } = await import("./idempotency");

let key = "";
const handler = vi.fn(async (): Promise<NextResponse> => NextResponse.json({}));
const route = withApiAuth(() => handler(), { requireScope: "admin" });
const vetoRoute = withApiAuth(() => handler(), {
  requireScope: "admin",
  cacheIdempotently: (_p, outcome) => !outcome || outcome.status === 201,
});
const post = (k: string, body = "{}", r = route) =>
  r(
    new Request("http://localhost/api/v1/things", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "idempotency-key": k, "content-type": "application/json" },
      body,
    }),
    { params: Promise.resolve({}) }
  );
const IDEM = "subAccounts/sa1/apiIdempotency";
const codeOf = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

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

it("3 parallel requests with one key run the handler exactly once; the others get in_progress or the replay", async () => {
  handler.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return NextResponse.json({ id: "c1" }, { status: 201 });
  });
  const results = await Promise.all([post("race-1"), post("race-1"), post("race-1")]);
  expect(handler).toHaveBeenCalledTimes(1);
  const statuses = results.map((r) => r.status).sort();
  expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
  for (const res of results.filter((r) => r.status !== 201)) {
    expect(res.status).toBe(409);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await codeOf(res)).toBe("idempotency_in_progress");
  }
  // Once finished, a retry replays the stored outcome without running again.
  expect((await post("race-1")).status).toBe(201);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(mem.list(IDEM)).toHaveLength(1);
});

it("a different body under an in-progress key is a collision, not in_progress", async () => {
  let finish = () => {};
  handler.mockImplementation(
    () => new Promise((r) => (finish = () => r(NextResponse.json({}, { status: 201 }))))
  );
  const first = post("k-mix", '{"a":1}');
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  const second = await post("k-mix", '{"a":2}');
  expect(second.status).toBe(409);
  expect(await codeOf(second)).toBe("idempotency_collision");
  finish();
  expect((await first).status).toBe(201);
});

it("an outcome the route vetoes releases the reservation, so a retry runs", async () => {
  handler.mockResolvedValue(NextResponse.json({ error: { code: "nope" } }, { status: 422 }));
  expect((await post("veto", "{}", vetoRoute)).status).toBe(422);
  expect(mem.list(IDEM)).toEqual([]);
  expect((await post("veto", "{}", vetoRoute)).status).toBe(422);
  expect(handler).toHaveBeenCalledTimes(2);
});

it("a handler throw releases the reservation, so a retry runs", async () => {
  handler.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(NextResponse.json({}, { status: 201 }));
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await post("throws")).status).toBe(500);
  spy.mockRestore();
  expect(mem.list(IDEM)).toEqual([]);
  expect((await post("throws")).status).toBe(201);
  expect(handler).toHaveBeenCalledTimes(2);
});

it("a dead process's in_progress reservation (no heartbeat, aged past expiry) is taken over", async () => {
  handler.mockResolvedValue(NextResponse.json({ id: "c2" }, { status: 201 }));
  const docId = `live_k1_${createHash("sha256").update("stale").digest("hex")}`;
  const dead = {
    state: "in_progress", reservationId: "dead", mode: "live",
    requestFingerprint: fingerprintRequest("POST", "/api/v1/things", "{}"),
  };
  mem.seed(`${IDEM}/${docId}`, { ...dead, expiresAt: new Date(Date.now() + 1000) });
  expect((await post("stale")).status).toBe(409);
  expect(handler).not.toHaveBeenCalled();

  mem.seed(`${IDEM}/${docId}`, { ...dead, expiresAt: new Date(Date.now() - 1000) });
  const res = await post("stale");
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ id: "c2" });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(mem.read(`${IDEM}/${docId}`)).toMatchObject({ state: "done", status: 201 });
});

it("a process whose reservation was taken over cannot overwrite or delete the new owner's outcome", async () => {
  const { reserveIdempotencyKey } = await import("./idempotency");
  handler.mockResolvedValue(NextResponse.json({ id: "new" }, { status: 201 }));
  const fp = fingerprintRequest("POST", "/api/v1/things", "{}");
  const old = await reserveIdempotencyKey("sa1", "live", "k1", "paused", fp);
  if (old.kind !== "reserved") throw new Error(`expected a reservation, got ${old.kind}`);
  const [doc] = mem.list(IDEM);
  const { id, ...data } = doc;
  mem.seed(`${IDEM}/${id}`, { ...data, expiresAt: new Date(Date.now() - 1000) }); // it stalled past expiry
  expect((await post("paused")).status).toBe(201);
  await old.store({ status: 201, bodyJson: { id: "old" } });
  await old.release();
  expect(await (await post("paused")).json()).toMatchObject({ id: "new" });
  expect(handler).toHaveBeenCalledTimes(1);
});
