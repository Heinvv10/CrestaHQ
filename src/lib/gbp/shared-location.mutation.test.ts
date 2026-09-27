import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * H1 (MULTI_LISTING_V1_PLAN.md): `listing_shared` must see a location held by
 * another sub-account EITHER as its main listing on a legacy doc (no
 * `googleLocationNames` — the equality query) OR only as an extra listing (the
 * `array-contains` query). Each branch has a case that goes red without it,
 * through the real auto-reply settings route and the real engine.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { getAdminDb } from "@/lib/firebase/admin";
import { LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { posts, resetAutoReply, reviewNameOf, sync, syncAndRun } from "@/test/auto-reply-harness";
import { PUT } from "@/app/api/sub-accounts/[id]/reputation/auto-reply/route";
import { heldByAnotherSubAccount } from "./shared-location";

const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" };
const ON = { enabled: true, modes: MODES, includeBacklog: false };
const ORIGINAL = { ...process.env };

const patch = (sa: string, fields: Record<string, unknown>) =>
  mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, ...fields });
const listingOf = (sa: string) => mem.read(`subAccounts/${sa}`)!.googleListing as Record<string, unknown>;

/** OTHER_SA's main is LOC_NORTH; it holds LOC_A only as an extra. */
function otherHoldsAsExtra() {
  const main = { ...listingOf(OTHER_SA), locationName: LOC_NORTH };
  patch(OTHER_SA, {
    googleListing: main,
    googleExtraListings: [{ ...main, locationName: LOC_A }],
    googleLocationNames: [LOC_NORTH, LOC_A],
  });
}
/** OTHER_SA's main is LOC_A on a doc written before `googleLocationNames` existed. */
function otherHoldsAsLegacyMain() {
  const doc = { ...mem.read(`subAccounts/${OTHER_SA}`)! };
  delete doc.googleLocationNames;
  delete doc.googleExtraListings;
  mem.seed(`subAccounts/${OTHER_SA}`, { ...doc, googleListing: { ...listingOf(OTHER_SA), locationName: LOC_A } });
}

const enable = async () => {
  const url = `http://127.0.0.1:3100/api/sub-accounts/${SA}/reputation/auto-reply`;
  const res = await PUT(asUser(url, "uid_admin", "PUT", JSON.stringify(ON)), { params: Promise.resolve({ id: SA }) });
  return [res.status, ((await res.json()) as { code?: string }).code ?? null];
};

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("PUT …/reputation/auto-reply {enabled:true}", () => {
  beforeEach(() => {
    resetSync();
    patch(SA, { reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true });
    patch(OTHER_SA, { googleListing: { ...listingOf(OTHER_SA), locationName: LOC_NORTH } });
  });

  it("(a) another sub-account holds the location ONLY as an extra → 409 listing_shared", async () => {
    otherHoldsAsExtra();
    expect(await enable()).toEqual([409, "listing_shared"]);
    expect(mem.read(`subAccounts/${SA}`)?.reviewsAutoReply).toBeUndefined();
  });

  it("(b) a legacy doc (no googleLocationNames) holding it as main → still 409 listing_shared", async () => {
    otherHoldsAsLegacyMain();
    expect(await enable()).toEqual([409, "listing_shared"]);
    expect(mem.read(`subAccounts/${SA}`)?.reviewsAutoReply).toBeUndefined();
  });

  it("single listing: unchanged — a different location elsewhere is not shared", async () => {
    expect(await enable()).toEqual([200, null]);
  });
});

describe("engine: confirmAutoPost", () => {
  const a1Posts = () => posts().filter((c) => c.reviewName === reviewNameOf("fake-a1"));
  beforeEach(() => {
    resetAutoReply();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("an extra-holder appearing after enable pauses the post", async () => {
    await sync();
    otherHoldsAsExtra();
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });

  it("a legacy main-holder appearing after enable pauses the post", async () => {
    await sync();
    otherHoldsAsLegacyMain();
    await syncAndRun();
    expect(a1Posts()).toHaveLength(0);
  });

  it("single listing: unchanged — nobody else holds it → posts", async () => {
    await syncAndRun();
    expect(a1Posts()).toHaveLength(1);
  });
});

describe("heldByAnotherSubAccount", () => {
  beforeEach(() => {
    resetSync();
    patch(OTHER_SA, { googleListing: { ...listingOf(OTHER_SA), locationName: LOC_NORTH } });
  });

  it("never counts the asking sub-account itself, as main or as extra", async () => {
    const db = getAdminDb();
    expect(await heldByAnotherSubAccount(db, null, LOC_A, SA)).toBe(false); // SA's own main
    patch(OTHER_SA, {
      googleExtraListings: [{ ...listingOf(OTHER_SA), locationName: "locations/x" }],
      googleLocationNames: [LOC_NORTH, "locations/x"],
    });
    expect(await heldByAnotherSubAccount(db, null, "locations/x", OTHER_SA)).toBe(false); // its own extra
    expect(await heldByAnotherSubAccount(db, null, "locations/x", SA)).toBe(true);
  });

  it("works inside a transaction", async () => {
    otherHoldsAsExtra();
    const db = getAdminDb();
    expect(await db.runTransaction((tx) => heldByAnotherSubAccount(db, tx, LOC_A, SA))).toBe(true);
    expect(await db.runTransaction((tx) => heldByAnotherSubAccount(db, tx, "locations/nobody", SA))).toBe(false);
  });
});
