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
  contact({ id: "c", name: "Cara", email: "", phone: "", tags: [], company: "Acme", source: "referral" }),
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
