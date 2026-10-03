import { describe, expect, it } from "vitest";

import { applyFilters } from "@/lib/contacts/filter";
import { evalConditionGroup, REPLY_TEXT_FIELD } from "@/lib/contacts/conditions";
import { CONDITION_OPS } from "@/lib/workflows/catalog";
import type { Contact } from "@/types/contacts";
import type { ConditionOp } from "@/types/workflows";

/**
 * `starts_with_word` and `not_contains` — written for branching on a WhatsApp
 * reply ("Yes i think everything is done" vs "Yes but the cable is hanging"),
 * where `contains "yes"` also catches "Yesterday" and nothing could say
 * "and not 'but'". Driven through evalConditionGroup, the one evaluator the
 * engine (trigger filters + if_else) and the contacts list all call.
 */

const contact = (over: Partial<Contact> = {}) =>
  ({ id: "c1", subAccountId: "sa1", name: "", email: "", phone: "", tags: [], ...over }) as Contact;

const onReply = (op: ConditionOp, value: string | undefined, replyText: string | null) =>
  evalConditionGroup({ all: [{ field: REPLY_TEXT_FIELD, op, value }] }, contact(), { replyText });

describe("starts_with_word", () => {
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
    expect(onReply("starts_with_word", "yes", reply)).toBe(true);
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
    expect(onReply("starts_with_word", "yes", reply)).toBe(false);
  });

  it("trims and case-folds the condition value too", () => {
    expect(onReply("starts_with_word", "  YES  ", "yes please")).toBe(true);
  });

  it("matches a multi-word value at a word boundary only", () => {
    expect(onReply("starts_with_word", "all good", "All good, thanks")).toBe(true);
    expect(onReply("starts_with_word", "all good", "All goodness")).toBe(false);
  });

  it("matches a value in a non-Latin script by the same rule", () => {
    expect(onReply("starts_with_word", "ja", "Ja, dankie")).toBe(true);
    expect(onReply("starts_with_word", "да", "Да, спасибо")).toBe(true);
    expect(onReply("starts_with_word", "да", "Давай")).toBe(false);
  });

  it("is a whole-word match, not a plain prefix", () => {
    expect(onReply("starts_with_word", "082", "0821234567")).toBe(false);
    expect(onReply("starts_with_word", "Joh", "John")).toBe(false);
    expect(onReply("starts_with_word", "John", "John Smith")).toBe(true);
  });

  it("a value ending in punctuation still needs a non-letter after it", () => {
    expect(onReply("starts_with_word", "yes,", "yes,good")).toBe(false);
    expect(onReply("starts_with_word", "yes,", "Yes, good")).toBe(true);
  });

  describe("Unicode", () => {
    const decomposed = "cafe\u0301"; // e + combining acute
    it("an accent typed precomposed or as a combining mark compares equal (NFC)", () => {
      expect(onReply("starts_with_word", "café", `${decomposed} latte`)).toBe(true);
      expect(onReply("starts_with_word", decomposed, "Café latte")).toBe(true);
    });

    it("an unaccented value does not match the accented word", () => {
      expect(onReply("starts_with_word", "cafe", "café latte")).toBe(false);
      expect(onReply("starts_with_word", "cafe", `${decomposed} latte`)).toBe(false);
    });

    it("a combining mark after the value is part of the word", () => {
      // Neither composes under NFC: "İ" lower-cases to i + U+0307, and a
      // Devanagari vowel sign (ा) follows its consonant as a mark.
      expect(onReply("starts_with_word", "i", "İstanbul")).toBe(false);
      expect(onReply("starts_with_word", "İstanbul", "İSTANBUL'da")).toBe(true);
      expect(onReply("starts_with_word", "ह", "हाँ")).toBe(false);
      expect(onReply("starts_with_word", "हाँ", "हाँ, सब ठीक है")).toBe(true);
    });

    it("strips zero-width characters at the edges of both sides", () => {
      expect(onReply("starts_with_word", "yes", "\u200BYes")).toBe(true);
      expect(onReply("starts_with_word", "yes", "\uFEFF\u2060 Yes, done\u200D")).toBe(true);
      expect(onReply("starts_with_word", "yes\u200C", "Yes")).toBe(true);
      expect(onReply("starts_with_word", "\u200B", "Yes")).toBe(false);
    });
  });

  it.each([[""], ["   "], [undefined]])("a blank value %j never matches, not even blank text", (value) => {
    expect(onReply("starts_with_word", value, "Yes")).toBe(false);
    expect(onReply("starts_with_word", value, "")).toBe(false);
  });

  it("no reply (null) is false", () => {
    expect(onReply("starts_with_word", "yes", null)).toBe(false);
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
        { value: "starts_with_word", label: "starts with the word" },
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

    expect(ids("starts_with_word", "ACME")).toEqual(["a", "c"]);
    expect(ids("not_contains", "holdings")).toEqual(["b", "c", "d"]);
  });
});
