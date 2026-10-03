import { describe, expect, it } from "vitest";

import { applyFilters } from "@/lib/contacts/filter";
import { evalConditionGroup, REPLY_TEXT_FIELD } from "@/lib/contacts/conditions";
import { CONDITION_OPS } from "@/lib/workflows/catalog";
import type { Contact } from "@/types/contacts";
import type { ConditionOp } from "@/types/workflows";

/**
 * `starts_with` and `not_contains` — written for branching on a WhatsApp
 * reply ("Yes i think everything is done" vs "Yes but the cable is hanging"),
 * where `contains "yes"` also catches "Yesterday" and nothing could say
 * "and not 'but'". Driven through evalConditionGroup, the one evaluator the
 * engine (trigger filters + if_else) and the contacts list all call.
 */

const contact = (over: Partial<Contact> = {}) =>
  ({ id: "c1", subAccountId: "sa1", name: "", email: "", phone: "", tags: [], ...over }) as Contact;

const onReply = (op: ConditionOp, value: string | undefined, replyText: string | null) =>
  evalConditionGroup({ all: [{ field: REPLY_TEXT_FIELD, op, value }] }, contact(), { replyText });

describe("starts_with", () => {
  it.each([
    ["Yes"],
    ["yes"],
    [" Yes! "],
    ["Yes, all good"],
    ["Yes i think everything is done"],
    ["YES👍"],
    ["yes."],
    ["Yes\nthanks"],
    ["Yes-ish"],
  ])("'yes' matches %j", (reply) => {
    expect(onReply("starts_with", "yes", reply)).toBe(true);
  });

  it.each([
    ["Yesterday"],
    ["Yess"],
    ["Yes2"],
    ["Yesé"],
    ["Yesñ"],
    ["Yes𝐀"],
    [""],
    ["   "],
    ["No, yes"],
    ["Ye"],
  ])("'yes' does NOT match %j", (reply) => {
    expect(onReply("starts_with", "yes", reply)).toBe(false);
  });

  it("trims and case-folds the condition value too", () => {
    expect(onReply("starts_with", "  YES  ", "yes please")).toBe(true);
  });

  it("matches a multi-word value at a word boundary only", () => {
    expect(onReply("starts_with", "all good", "All good, thanks")).toBe(true);
    expect(onReply("starts_with", "all good", "All goodness")).toBe(false);
  });

  it("matches a value in a non-Latin script by the same rule", () => {
    expect(onReply("starts_with", "ja", "Ja, dankie")).toBe(true);
    expect(onReply("starts_with", "да", "Да, спасибо")).toBe(true);
    expect(onReply("starts_with", "да", "Давай")).toBe(false);
  });

  it.each([[""], ["   "], [undefined]])("a blank value %j never matches, not even blank text", (value) => {
    expect(onReply("starts_with", value, "Yes")).toBe(false);
    expect(onReply("starts_with", value, "")).toBe(false);
  });

  it("no reply (null) is false", () => {
    expect(onReply("starts_with", "yes", null)).toBe(false);
  });
});

describe("not_contains", () => {
  it.each([
    ["Yes i think everything is done", true],
    ["Yes but the cable is hanging", false],
    ["BUT why", false],
    ["Butter", false],
    ["", true],
  ])("'but' on %j → %s", (reply, expected) => {
    expect(onReply("not_contains", "but", reply)).toBe(expected);
  });

  it("no reply (null) does not contain the value", () => {
    expect(onReply("not_contains", "but", null)).toBe(true);
  });

  it("is the exact negation of contains, blank value included", () => {
    for (const value of ["but", " BUT ", "", "   ", undefined]) {
      for (const reply of ["Yes but no", "yes", "", null]) {
        expect(onReply("not_contains", value, reply)).toBe(!onReply("contains", value, reply));
      }
    }
  });

  it("a blank value matches nothing", () => {
    expect(onReply("not_contains", "", "anything")).toBe(false);
    expect(onReply("not_contains", "", null)).toBe(false);
  });
});

describe("the builder and the contacts list", () => {
  it("both ops are offered, with their labels", () => {
    expect(CONDITION_OPS).toEqual(
      expect.arrayContaining([
        { value: "starts_with", label: "starts with" },
        { value: "not_contains", label: "does not contain" },
      ]),
    );
  });

  it("a smart list filters contacts with them", () => {
    const list = [
      contact({ id: "a", company: "Acme Holdings" }),
      contact({ id: "b", company: "Acmeworks" }),
      contact({ id: "c", company: "acme" }),
      contact({ id: "d" }),
    ];
    const ids = (op: ConditionOp, value: string) =>
      applyFilters(list, { all: [{ field: "company", op, value }] }).map((c) => c.id);

    expect(ids("starts_with", "ACME")).toEqual(["a", "c"]);
    expect(ids("not_contains", "holdings")).toEqual(["b", "c", "d"]);
  });
});
