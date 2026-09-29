import { describe, expect, it } from "vitest";
import { showOlderNotice, tabIsPartial } from "./appointments-window";

const NONE = { upcomingTruncated: false, pastTruncated: false };
const PAST = { upcomingTruncated: false, pastTruncated: true };
const UPCOMING = { upcomingTruncated: true, pastTruncated: false };

describe("tabIsPartial", () => {
  it("Upcoming is only partial when the upcoming half is capped", () => {
    expect(tabIsPartial("upcoming", PAST)).toBe(false);
    expect(tabIsPartial("upcoming", UPCOMING)).toBe(true);
  });
  it("Cancelled and All span both halves", () => {
    for (const tab of ["cancelled", "all"] as const) {
      expect(tabIsPartial(tab, NONE)).toBe(false);
      expect(tabIsPartial(tab, PAST)).toBe(true);
      expect(tabIsPartial(tab, UPCOMING)).toBe(true);
    }
  });
});

describe("showOlderNotice", () => {
  it("never on Upcoming, which shows no past events", () => {
    expect(showOlderNotice("upcoming", PAST)).toBe(false);
  });
  it("on Cancelled and All whenever older events were not loaded", () => {
    expect(showOlderNotice("cancelled", PAST)).toBe(true);
    expect(showOlderNotice("all", PAST)).toBe(true);
    expect(showOlderNotice("all", NONE)).toBe(false);
  });
});
