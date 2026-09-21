import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/reply — who may
 * post, to which review, with what body, on which connection. Every refusal
 * must reach Google zero times and write nothing. Real route, real
 * require-tenancy, real gate, real fake provider behind the real fence; only
 * Firestore is in memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  AGENCY, FOREIGN_AGENCY, FOREIGN_SA, LEAK_MARKERS, OTHER_SA, SA, claims, mem, resetSync, seedSub,
} from "@/test/gbp-sync-harness";
import { KEY, attempts, callReply, calls, docIdOf, reviewPath } from "@/test/gbp-reply-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const R6 = docIdOf("fake-r6");
const ok = (over: Record<string, unknown> = {}) => ({ comment: "Thanks for the feedback.", idempotencyKey: KEY, ...over });

async function post(uid: string, sa: string, docId: string, body: unknown = ok()) {
  const r = await callReply(POST, "POST", uid, sa, docId, body);
  expect(r.text).not.toMatch(LEAK_MARKERS);
  return r;
}

/** Nothing reached Google and nothing was written for SA or OTHER_SA. */
function expectUntouched() {
  expect(calls(SA)).toEqual([]);
  expect(calls(OTHER_SA)).toEqual([]);
  expect(attempts(SA)).toEqual([]);
  expect(attempts(OTHER_SA)).toEqual([]);
  expect(mem.read(reviewPath("fake-r6"))?.reply).toBeNull();
}

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  await syncListing(OTHER_SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("who may post", () => {
  it("lets a sub-account admin post", async () => {
    expect((await post("uid_admin", SA, R6)).status).toBe(200);
  });

  it.each([
    ["a collaborator (read-only role)", "uid_collab"],
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s — zero calls, nothing written", async (_l, uid) => {
    expect((await post(uid, SA, R6)).status).toBe(403);
    expectUntouched();
  });

  it("another tenant's admin guessing this review's id on their own sub-account gets 404 and zero calls", async () => {
    // OTHER_SA is synced from the same fixture, but its cache holds the doc
    // only because the ids are deterministic — so drop it: a guessed id from
    // another tenant must name nothing under the caller's own sub-account.
    await mem.db.doc(reviewPath("fake-r6", OTHER_SA)).delete();
    const r = await post("uid_other_admin", OTHER_SA, R6);
    expect(r.status).toBe(404);
    expectUntouched();
  });

  it("refuses with gate_off when the agency gate is off", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleEnabledByAgency: false });
    const r = await post("uid_admin", SA, R6);
    expect(r).toMatchObject({ status: 403, body: { code: "gate_off" } });
    expectUntouched();
  });

  it("answers gate_off before looking at the review — even for an id that does not exist", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleEnabledByAgency: false });
    expect(await post("uid_admin", SA, "0".repeat(40))).toMatchObject({ status: 403, body: { code: "gate_off" } });
  });
});

describe("which review", () => {
  it("404s a review Google removed (a tombstone)", async () => {
    mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, state: "removed" });
    expect((await post("uid_admin", SA, R6)).status).toBe(404);
    expect(calls()).toEqual([]);
  });

  it("404s a cached review of another listing", async () => {
    mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, locationName: "locations/some-other" });
    expect((await post("uid_admin", SA, R6)).status).toBe(404);
    expect(calls()).toEqual([]);
  });

  it("404s an id that smuggles a path — even onto an active-looking nested doc — zero calls", async () => {
    const smuggled = `${R6}/nested/doc`;
    mem.seed(`subAccounts/${SA}/gbpReviews/${smuggled}`, { ...mem.read(reviewPath("fake-r6"))! });
    expect((await post("uid_admin", SA, smuggled)).status).toBe(404);
    expect(calls()).toEqual([]);
  });

  it.each(["nope", R6.toUpperCase(), `${R6}0`, "..%2Fprivate%2FgoogleConnection"])("404s a malformed id %s", async (id) => {
    expect((await post("uid_admin", SA, id)).status).toBe(404);
    expect(calls()).toEqual([]);
  });
});

describe("the body", () => {
  it.each<[string, unknown]>([
    ["not JSON", "not json"],
    ["no comment", { idempotencyKey: KEY }],
    ["a blank comment", ok({ comment: "  \n\t " })],
    ["a comment over 4000 characters", ok({ comment: "x".repeat(4001) })],
    ["a non-string comment", ok({ comment: 5 })],
    ["no idempotency key", { comment: "Hi" }],
    ["a key under 8 characters", ok({ idempotencyKey: "short" })],
    ["a key over 128 characters", ok({ idempotencyKey: "k".repeat(129) })],
  ])("400 invalid_body on %s — zero calls", async (_l, body) => {
    const r = await post("uid_admin", SA, R6, body);
    expect(r).toMatchObject({ status: 400, body: { code: "invalid_body" } });
    expectUntouched();
  });

  it("accepts exactly 4000 characters and sends them untrimmed", async () => {
    const comment = ` ${"y".repeat(3998)}\n`;
    const r = await post("uid_admin", SA, R6, ok({ comment }));
    expect(r.status).toBe(200);
    expect((mem.read(reviewPath("fake-r6"))?.reply as { comment: string }).comment).toBe(comment);
  });
});

describe("the connection", () => {
  it("409 reconnect_required when the connection is flagged — zero calls", async () => {
    seedSub(SA, { reconnectRequired: true });
    expect((await post("uid_admin", SA, R6))).toMatchObject({ status: 409, body: { code: "reconnect_required" } });
    expectUntouched();
  });

  it("409 not_connected when Google is disconnected — zero calls", async () => {
    seedSub(SA, { connected: false });
    expect((await post("uid_admin", SA, R6))).toMatchObject({ status: 409, body: { code: "not_connected" } });
    expectUntouched();
  });

  it("in fake mode refuses a sub-account outside the fixture agency before writing anything", async () => {
    seedSub(FOREIGN_SA, { agencyId: FOREIGN_AGENCY });
    mem.seed(`subAccounts/${FOREIGN_SA}/subAccountMembers/uid_foreign`, { status: "active", subAccountRole: "admin", role: "admin" });
    claims.set("uid_foreign", { status: "active", agencyId: FOREIGN_AGENCY, agencyRole: null });
    mem.seed(reviewPath("fake-r6", FOREIGN_SA), { ...mem.read(reviewPath("fake-r6"))!, agencyId: FOREIGN_AGENCY, subAccountId: FOREIGN_SA });
    const r = await post("uid_foreign", FOREIGN_SA, R6);
    expect(r).toMatchObject({ status: 503, body: { code: "not_configured" } });
    expect(attempts(FOREIGN_SA)).toEqual([]);
    expect(calls(FOREIGN_SA)).toEqual([]);
    expect(AGENCY).not.toBe(FOREIGN_AGENCY);
  });
});
