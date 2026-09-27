import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/reputation/auto-reply/alerts", () => ({ sendAutoReplyAlert: async () => {} }));

import { getAdminDb } from "@/lib/firebase/admin";
import { LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { PUT } from "@/app/api/sub-accounts/[id]/reputation/auto-reply/route";
import { heldByAnotherSubAccount } from "./shared-location";
import { clearListing } from "./listing-events";
import { allListings } from "./listings";

const ON = { enabled: true, modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" }, includeBacklog: false };
const patch = (sa: string, f: Record<string, unknown>) => mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, ...f });
const listingOf = (sa: string) => mem.read(`subAccounts/${sa}`)!.googleListing as Record<string, unknown>;
const enable = async () => {
  const res = await PUT(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/reputation/auto-reply`, "uid_admin", "PUT", JSON.stringify(ON)), { params: Promise.resolve({ id: SA }) });
  return [res.status, ((await res.json()) as { code?: string }).code ?? null];
};

beforeEach(() => {
  resetSync();
  patch(SA, { reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true });
  patch(OTHER_SA, { googleListing: { ...listingOf(OTHER_SA), locationName: LOC_NORTH } });
});

describe("clearListing keeps the flat array equal to the listing fields", () => {
  it("clearing OTHER_SA drops its extras too, so nothing it listed is invisible to listing_shared", async () => {
    const main = listingOf(OTHER_SA);
    patch(OTHER_SA, { googleExtraListings: [{ ...main, locationName: LOC_A }], googleLocationNames: [LOC_NORTH, LOC_A] });
    expect(await heldByAnotherSubAccount(getAdminDb(), null, LOC_A, SA)).toBe(true);
    await clearListing(OTHER_SA, "uid_admin", "admin_cleared");
    const doc = mem.read(`subAccounts/${OTHER_SA}`)!;
    // invariant: flat array == derived names
    expect(doc.googleLocationNames).toEqual(allListings(doc as never).map((l) => l.locationName));
  });
});

describe("a stale googleLocationNames never refuses", () => {
  it("OTHER_SA no longer has any listing but a stale array → SA wrongly refused", async () => {
    // State left by: e2e resetConnection (FieldValue.delete googleListing only), or an old-code clear after a blue/green --rollback.
    patch(OTHER_SA, { googleListing: null, googleLocationNames: [LOC_A] });
    expect(allListings(mem.read(`subAccounts/${OTHER_SA}`) as never)).toEqual([]);
    expect(await enable()).toEqual([200, null]);
  });
});
