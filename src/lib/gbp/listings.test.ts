import { describe, expect, it } from "vitest";
import type { GoogleListing } from "@/types/google";
import { allListings, isMain, listingFor, locationNamesOf, locId, MAX_EXTRA_LISTINGS } from "./listings";

const listing = (locationName: string, title = locationName): GoogleListing => ({
  accountName: "accounts/1", accountDisplayName: "Group", locationName, title, address: "",
  websiteUri: null, placeId: null, mapsUri: null, newReviewUri: null,
  selectedAt: new Date(0), selectedByUid: "uid",
});
const MAIN = listing("locations/111", "Pretoria");
const B = listing("locations/222", "Gqeberha");
const C = listing("locations/333", "Durban");

describe("listings", () => {
  it("caps extras at 9", () => {
    expect(MAX_EXTRA_LISTINGS).toBe(9);
  });

  it("locId is the id after locations/", () => {
    expect(locId("locations/17056136057407481399")).toBe("17056136057407481399");
    expect(locId("locations/e2e-velo_x")).toBe("e2e-velo_x");
  });

  it("single listing: unchanged — only the main", () => {
    const sub = { googleListing: MAIN };
    expect(allListings(sub)).toEqual([MAIN]);
    expect(locationNamesOf(sub)).toEqual(["locations/111"]);
  });

  it("main first, then extras in stored order — derived from the listing fields, not the flat array", () => {
    const sub = { googleListing: MAIN, googleExtraListings: [B, C], googleLocationNames: ["locations/stale"] };
    expect(allListings(sub)).toEqual([MAIN, B, C]);
    expect(locationNamesOf(sub)).toEqual(["locations/111", "locations/222", "locations/333"]);
  });

  it("no listing → nothing", () => {
    expect(allListings({})).toEqual([]);
    expect(allListings({ googleListing: null })).toEqual([]);
    expect(locationNamesOf({ googleListing: null, googleExtraListings: [] })).toEqual([]);
  });

  it("listingFor finds main or an extra, and nothing else", () => {
    const sub = { googleListing: MAIN, googleExtraListings: [B] };
    expect(listingFor(sub, "locations/111")).toBe(MAIN);
    expect(listingFor(sub, "locations/222")).toBe(B);
    expect(listingFor(sub, "locations/333")).toBeNull();
  });

  it("isMain is true only for the main listing", () => {
    const sub = { googleListing: MAIN, googleExtraListings: [B] };
    expect(isMain(sub, "locations/111")).toBe(true);
    expect(isMain(sub, "locations/222")).toBe(false);
    expect(isMain({ googleListing: null }, "locations/111")).toBe(false);
  });
});
