import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The apiIdempotency sweep deletes a doc only if, re-read inside a
 * transaction, it is still expired and still the same reservation — a
 * request may take over (or a heartbeat extend) it between query and delete.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true, publishCallback: async () => null }));
vi.mock("@/lib/server/agents-watchdog-service", () => ({ sweepOldWatchdogRuns: async () => 0 }));
vi.mock("@/lib/server/agent-proposals-sweeps", () => ({
  sweepAgentProposals: async () => ({ collection: "agentProposals", deleted: 0, hitCap: false }),
}));

const { POST } = await import("./route");
const run = () =>
  POST(new Request("https://app.test/api/cron/api-cleanup", { method: "POST", headers: { "upstash-signature": "sig" }, body: "{}" }));
const DOC = "subAccounts/sa1/apiIdempotency/live_k1_x";
const past = () => new Date(Date.now() - 1000);
const future = () => new Date(Date.now() + 60_000);

beforeEach(() => {
  mem.clear();
  vi.restoreAllMocks();
});

it("deletes an expired doc and keeps a live one", async () => {
  mem.seed(DOC, { state: "done", status: 201, expiresAt: past() });
  mem.seed(`${DOC}2`, { state: "done", status: 201, expiresAt: future() });
  expect((await run()).status).toBe(200);
  expect(mem.read(DOC)).toBeUndefined();
  expect(mem.read(`${DOC}2`)).toBeDefined();
});

it.each([
  ["taken over by a new reservation", { state: "in_progress", reservationId: "new", expiresAt: future() }],
  ["taken over by a new reservation that is itself already expired", { state: "in_progress", reservationId: "new", expiresAt: past() }],
  ["extended by a heartbeat", { state: "in_progress", reservationId: "old", expiresAt: future() }],
])("keeps a reservation %s between the query and the delete", async (_label, replacement) => {
  mem.seed(DOC, { state: "in_progress", reservationId: "old", expiresAt: past() });
  const orig = mem.db.runTransaction.bind(mem.db);
  vi.spyOn(mem.db, "runTransaction").mockImplementation(((fn: never) => {
    mem.seed(DOC, replacement);
    return orig(fn);
  }) as never);
  expect((await run()).status).toBe(200);
  expect(mem.read(DOC)).toMatchObject({ reservationId: replacement.reservationId, state: "in_progress" });
});
