import { describe, expect, it } from "vitest";

import { applyFilters, matchesSearch } from "@/lib/contacts/filter";
import { evalConditionGroup } from "@/lib/contacts/conditions";
import type { Contact } from "@/types/contacts";

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    subAccountId: "sa1",
    name: "",
    email: "",
    phone: "",
    company: "",
    tags: [],
    ...over,
  } as Contact;
}

const fixture: Contact[] = [
  contact({ id: "a", name: "Alice", email: "alice@x.io", phone: "+27 82 123 4567", tags: ["vip"], company: "Acme" }),
  contact({ id: "b", name: "Bob", email: "bob@x.io", phone: "0821234567", tags: ["lead"], company: "" }),
  contact({
    id: "c",
    name: "Cara",
    email: "",
    phone: "",
    tags: [],
    company: "Acme",
    source: "referral",
    customFields: { plan: "Gold" },
  }),
];

const ids = (list: Contact[]) => list.map((c) => c.id);

describe("evalConditionGroup (isomorphic module)", () => {
  it("evaluates has_tag against the tags array", () => {
    expect(
      evalConditionGroup({ all: [{ field: "tags", op: "has_tag", value: "vip" }] }, fixture[0]),
    ).toBe(true);
    expect(
      evalConditionGroup({ all: [{ field: "tags", op: "has_tag", value: "vip" }] }, fixture[1]),
    ).toBe(false);
  });
});

describe("applyFilters", () => {
  it("returns every contact for an empty group", () => {
    expect(applyFilters(fixture, { all: [] })).toBe(fixture);
    expect(applyFilters(fixture, undefined)).toBe(fixture);
  });

  it("filters by has_tag", () => {
    expect(ids(applyFilters(fixture, { all: [{ field: "tags", op: "has_tag", value: "vip" }] }))).toEqual(["a"]);
  });

  it("filters by equals", () => {
    expect(ids(applyFilters(fixture, { all: [{ field: "company", op: "equals", value: "Acme" }] }))).toEqual(["a", "c"]);
  });

  it("filters by is_set", () => {
    expect(ids(applyFilters(fixture, { all: [{ field: "email", op: "is_set" }] }))).toEqual(["a", "b"]);
  });

  it("filters by contains, case-insensitively", () => {
    expect(ids(applyFilters(fixture, { all: [{ field: "email", op: "contains", value: "@X.IO" }] }))).toEqual(["a", "b"]);
    expect(ids(applyFilters(fixture, { all: [{ field: "name", op: "contains", value: "ar" }] }))).toEqual(["c"]);
  });

  it("filters on customFields.* paths, treating a missing object as unset", () => {
    expect(ids(applyFilters(fixture, { all: [{ field: "customFields.plan", op: "equals", value: "Gold" }] }))).toEqual(["c"]);
    expect(ids(applyFilters(fixture, { all: [{ field: "customFields.plan", op: "is_set" }] }))).toEqual(["c"]);
    // a and b have no customFields object at all; that must read as "not set"
    // rather than throw or match.
    expect(ids(applyFilters(fixture, { all: [{ field: "customFields.plan", op: "not_set" }] }))).toEqual(["a", "b"]);
  });

  it("filters by assignedToUid (equals / is_set / not_set)", () => {
    const assigned = [contact({ id: "x", assignedToUid: "m1" }), contact({ id: "y", assignedToUid: null }), contact({ id: "z" })];
    expect(ids(applyFilters(assigned, { all: [{ field: "assignedToUid", op: "equals", value: "m1" }] }))).toEqual(["x"]);
    expect(ids(applyFilters(assigned, { all: [{ field: "assignedToUid", op: "is_set" }] }))).toEqual(["x"]);
    expect(ids(applyFilters(assigned, { all: [{ field: "assignedToUid", op: "not_set" }] }))).toEqual(["y", "z"]);
  });

  it("tolerates a malformed group with no `all` array", () => {
    expect(applyFilters(fixture, { all: undefined as unknown as never })).toBe(fixture);
  });

  it("match all requires every condition", () => {
    expect(
      ids(
        applyFilters(fixture, {
          match: "all",
          all: [
            { field: "company", op: "equals", value: "Acme" },
            { field: "email", op: "is_set" },
          ],
        }),
      ),
    ).toEqual(["a"]);
  });

  it("match any requires one condition", () => {
    expect(
      ids(
        applyFilters(fixture, {
          match: "any",
          all: [
            { field: "tags", op: "has_tag", value: "lead" },
            { field: "source", op: "source_is", value: "referral" },
          ],
        }),
      ),
    ).toEqual(["b", "c"]);
  });
});

describe("matchesSearch", () => {
  it("matches name, email and company case-insensitively", () => {
    expect(matchesSearch(fixture[0], "ALICE")).toBe(true);
    expect(matchesSearch(fixture[1], "bob@x")).toBe(true);
    expect(matchesSearch(fixture[2], "acme")).toBe(true);
    expect(matchesSearch(fixture[1], "acme")).toBe(false);
  });

  it("matches phone ignoring formatting on both sides", () => {
    expect(matchesSearch(fixture[0], "82 123")).toBe(true);
    expect(matchesSearch(fixture[0], "+27821234567")).toBe(true);
    expect(matchesSearch(fixture[1], "(082) 123-4567")).toBe(true);
    expect(matchesSearch(fixture[0], "999")).toBe(false);
  });

  it("does not treat a letters-only query as a phone match", () => {
    // Stripping non-digits from "bob" yields "" — an empty needle must not
    // match every contact that has a phone.
    expect(matchesSearch(fixture[0], "bob")).toBe(false);
  });

  it("treats an empty query as a match", () => {
    expect(matchesSearch(fixture[2], "  ")).toBe(true);
  });
});
