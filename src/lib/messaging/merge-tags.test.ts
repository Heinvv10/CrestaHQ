import { describe, expect, it } from "vitest";
import {
  MERGE_FIELDS,
  renderMergeTags,
  type MergeTagContext,
} from "./merge-tags";

const ctx: MergeTagContext = {
  contact: {
    name: "  Thabo Sipho Mokoena ",
    email: "thabo@example.com",
    phone: "+27825550100",
    company: "Mokoena Fibre",
  },
  businessName: "Velo Desk",
  userName: "Anele",
  reviewUrl: "https://g.page/r/abc",
};

const render = (t: string, c: MergeTagContext = ctx) => renderMergeTags(t, c);

describe("canonical tags", () => {
  it.each([
    ["{{contact.first_name}}", "Thabo"],
    ["{{contact.last_name}}", "Sipho Mokoena"],
    ["{{contact.name}}", "Thabo Sipho Mokoena"],
    ["{{contact.email}}", "thabo@example.com"],
    ["{{contact.phone}}", "+27825550100"],
    ["{{contact.company}}", "Mokoena Fibre"],
    ["{{business.name}}", "Velo Desk"],
    ["{{user.name}}", "Anele"],
  ])("%s renders %s", (tag, expected) => {
    expect(render(`Hi ${tag}!`)).toEqual({
      text: `Hi ${expected}!`,
      unresolved: [],
    });
  });

  it("every picker field is a tag the renderer resolves", () => {
    for (const { tag } of MERGE_FIELDS) {
      expect(render(tag).unresolved, tag).toEqual([]);
      expect(render(tag).text, tag).not.toContain("{{");
    }
  });

  it("tolerates whitespace and case inside the braces", () => {
    expect(render("{{ contact.first_name }}|{{\tBusiness.Name\n}}").text).toBe(
      "Thabo|Velo Desk"
    );
  });

  it("reports a missing value as unresolved and leaves the tag visible", () => {
    const r = render("Hi {{contact.first_name}}, re {{ contact.email }}", {
      contact: { name: "", email: null },
    });
    expect(r.text).toBe("Hi {{contact.first_name}}, re {{ contact.email }}");
    expect(r.unresolved).toEqual([
      "{{contact.first_name}}",
      "{{ contact.email }}",
    ]);
  });

  it("a one-word name has no last name", () => {
    expect(
      render("{{contact.last_name}}", { contact: { name: "Thabo" } })
    ).toEqual({
      text: "{{contact.last_name}}",
      unresolved: ["{{contact.last_name}}"],
    });
  });

  it("a whitespace-only value is unresolved", () => {
    expect(
      render("{{business.name}}", { businessName: "   " }).unresolved
    ).toEqual(["{{business.name}}"]);
  });

  it("unknown tags are unresolved, de-duplicated, in order", () => {
    const r = render("{{foo}} {{contact.bogus}} {{foo}}");
    expect(r.text).toBe("{{foo}} {{contact.bogus}} {{foo}}");
    expect(r.unresolved).toEqual(["{{foo}}", "{{contact.bogus}}"]);
  });

  it("drop mode removes unresolved tags but still reports them", () => {
    const r = renderMergeTags(
      "A{{foo}}B{{contact.email}}C",
      {},
      { unknown: "drop" }
    );
    expect(r).toEqual({
      text: "ABC",
      unresolved: ["{{foo}}", "{{contact.email}}"],
    });
  });
});

describe("legacy aliases", () => {
  it.each([
    ["{{firstName}}", "Thabo"],
    ["{{contact.firstName}}", "Thabo"],
    ["{{businessName}}", "Velo Desk"],
    ["{{workspace.name}}", "Velo Desk"],
    ["{{reviewUrl}}", "https://g.page/r/abc"],
    ["{{ FIRSTNAME }}", "Thabo"],
  ])("%s renders %s", (tag, expected) => {
    expect(render(tag)).toEqual({ text: expected, unresolved: [] });
  });

  it("a missing legacy value renders empty and is NOT unresolved", () => {
    expect(
      render("Hi {{firstName}} at {{businessName}} {{reviewUrl}}", {})
    ).toEqual({
      text: "Hi  at  ",
      unresolved: [],
    });
  });

  it("matches the inner tag of triple braces, like the old regexes", () => {
    expect(render("{{{firstName}}}").text).toBe("{Thabo}");
  });
});

describe("values are inserted once, verbatim", () => {
  it("braces inside a value are not rendered a second time", () => {
    const r = render("Hi {{contact.name}} from {{business.name}}", {
      contact: { name: "{{business.name}} {{foo}}" },
      businessName: "Velo Desk",
    });
    expect(r.text).toBe("Hi {{business.name}} {{foo}} from Velo Desk");
    expect(r.unresolved).toEqual([]);
  });

  it("replacement patterns in a value are literal", () => {
    expect(
      render("{{contact.company}}", { contact: { company: "A$&B $1" } }).text
    ).toBe("A$&B $1");
  });

  it("leaves text without tags untouched", () => {
    const text = "Price: {not a tag} }} {{ done";
    expect(render(text)).toEqual({ text, unresolved: [] });
  });
});
