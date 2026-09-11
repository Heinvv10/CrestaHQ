import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/sub-accounts/[id]/gbp/sync — "Sync now". Real require-tenancy,
 * real gate, real syncListing, real fake provider; only Firestore and Firebase
 * Auth are in-memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  FOREIGN_AGENCY,
  FOREIGN_SA,
  LEAK_MARKERS,
  OTHER_SA,
  SA,
  activeReviews,
  asUser,
  mem,
  resetSync,
  reviews,
  runs,
  seedSub,
} from "@/test/gbp-sync-harness";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const url = (sa: string) => `http://127.0.0.1:3100/api/sub-accounts/${sa}/gbp/sync`;

async function syncNow(uid: string, sa = SA) {
  const res = await POST(asUser(url(sa), uid, "POST"), { params: Promise.resolve({ id: sa }) });
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  return { status: res.status, body: JSON.parse(text) as Record<string, Record<string, unknown>> };
}

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("authorization", () => {
  it.each([
    ["a collaborator (read-only role)", "uid_collab"],
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s and syncs nothing", async (_l, uid) => {
    expect((await syncNow(uid)).status).toBe(403);
    expect(reviews()).toHaveLength(0);
    expect(runs()).toHaveLength(0);
  });

  it("refuses with gate_off when the agency gate is off, recording nothing", async () => {
    seedSub(SA, { gateOn: false });
    const res = await syncNow("uid_admin");
    expect(res).toEqual({ status: 403, body: { error: expect.any(String), code: "gate_off" } });
    expect(runs()).toHaveLength(0);
  });

  it("refuses in fake mode for a sub-account of another agency, writing nothing", async () => {
    seedSub(FOREIGN_SA, { agencyId: FOREIGN_AGENCY });
    mem.seed(`subAccounts/${FOREIGN_SA}/subAccountMembers/uid_admin`, { status: "active", role: "admin" });
    await expect(
      POST(asUser(url(FOREIGN_SA), "uid_admin", "POST"), { params: Promise.resolve({ id: FOREIGN_SA }) }),
    ).rejects.toThrow("GBP fake provider refused");
    expect(reviews(FOREIGN_SA)).toHaveLength(0);
    expect(runs(FOREIGN_SA)).toHaveLength(0);
  });
});

describe("an admin's Sync now", () => {
  it("runs the core inline as a manual run and returns only the public subset", async () => {
    const { status, body } = await syncNow("uid_admin");
    expect(status).toBe(200);
    expect(body.run).toEqual({
      trigger: "manual", status: "success", startedAt: expect.any(String), finishedAt: expect.any(String),
      pagesFetched: 3, reviewsSeen: 7, created: 7, updated: 0, unchanged: 0, removed: 0, purged: 0,
      reconciliation: "full", resumedFromCursor: false, errorKind: null, skipReason: null,
    });
    expect(activeReviews()).toHaveLength(7);
    expect(runs()[0]).toMatchObject({ trigger: "manual", actorUid: "uid_admin" });
    expect(reviews(OTHER_SA)).toHaveLength(0);
  });

  it("reports a skip as a result, not an error", async () => {
    seedSub(SA, { listing: null });
    const { status, body } = await syncNow("uid_admin");
    expect(status).toBe(200);
    expect(body.run).toMatchObject({ status: "skipped", skipReason: "no_listing" });
  });
});
