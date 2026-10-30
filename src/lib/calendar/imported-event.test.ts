import { describe, expect, it } from "vitest";
import { importedOwnerName } from "./imported-event";

const roster = [
  { uid: "ann", displayName: "Ann Smith" },
  { uid: "bob", displayName: "  " },
];

describe("importedOwnerName", () => {
  it("names the owner from the roster", () => {
    expect(importedOwnerName(roster, "ann")).toBe("Ann Smith");
  });
  it("is null for a member who left, a blank name, or no owner", () => {
    expect(importedOwnerName(roster, "zed")).toBeNull();
    expect(importedOwnerName(roster, "bob")).toBeNull();
    expect(importedOwnerName(roster, null)).toBeNull();
    expect(importedOwnerName(roster, undefined)).toBeNull();
  });
});
