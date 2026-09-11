import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () =>
  (await import("@/test/google-oauth-harness")).adminMock(),
);
vi.mock("firebase-admin/firestore", async () =>
  (await import("@/test/google-oauth-harness")).firestoreMock(),
);

import { SUB, SUB_PATH, resetHarness, state } from "@/test/google-oauth-harness";
import { clearListing, reverifyListingAfterReconnect } from "./listing-events";
import type { GbpProvider } from "./provider/types";

/**
 * clearListing with `onlyIf`: the re-verify after a reconnect checked ONE
 * listing; if an admin picked another in the meantime, that newer choice must
 * survive.
 */

beforeEach(() => {
  resetHarness();
  state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleListing: { locationName: "locations/new" } });
});

describe("clearListing onlyIf", () => {
  it("leaves a listing that changed since it was checked, and logs nothing", async () => {
    await clearListing(SUB, "uid_admin", "not_accessible_after_reconnect", { onlyIf: "locations/old" });
    expect(state.docs.get(SUB_PATH)?.googleListing).toEqual({ locationName: "locations/new" });
    expect(state.writes).toEqual([]);
  });

  it("clears the listing it was told about", async () => {
    await clearListing(SUB, "uid_admin", "not_accessible_after_reconnect", { onlyIf: "locations/new" });
    expect(state.docs.get(SUB_PATH)?.googleListing).toBeNull();
    expect(state.writes.filter((w) => w.path.includes("/gbpEvents/"))).toHaveLength(1);
  });
});

describe("reverifyListingAfterReconnect", () => {
  it("does not clear a listing an admin re-picked while the check was in flight", async () => {
    state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleListing: { locationName: "locations/old" } });
    const provider = {
      listAccounts: async () => ({ items: [{ name: "accounts/a", accountName: "A", type: "PERSONAL" }], nextPageToken: null }),
      listLocations: async () => {
        // A concurrent PUT lands a new selection mid-check.
        state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleListing: { locationName: "locations/new" } });
        return { items: [], nextPageToken: null };
      },
    } as unknown as GbpProvider;
    await reverifyListingAfterReconnect(SUB, "uid_admin", provider, "tok", {
      accountName: "accounts/a",
      locationName: "locations/old",
    });
    expect(state.docs.get(SUB_PATH)?.googleListing).toEqual({ locationName: "locations/new" });
  });
});
