import { describe, expect, it } from "vitest";
import {
  cleanOpener,
  exactSmsSegments,
  fitWithSuffix,
  hasOptOutWording,
  normaliseSmsText,
  refusedTokens,
  stripOptOutSentences,
} from "./outbound-sms-text";

/** The AI first text's output check and shaping (pure functions). */

describe("refusedTokens", () => {
  it.each([
    ["Visit https://acme.co.za/x now", ""],
    ["Visit acme.co.za now", ""],
    ["Mail info@acme.co.za", ""],
    ["Call 082 123 4567 today", ""],
    ["Call (011) 555-0100 today", ""],
    ["Tap tel:112", ""],
    ["Tap tel: 112", ""],
    ["Write to sam @ evil", ""],
    ["Go to evil dot com", ""],
    ["Go to evil[.]com", ""],
    ["Go to evil (dot) com", ""],
    ["Go to hxxp evil", ""],
    ["Go to evil . com", ""],
    ["Go to evil. com", ""],
    ["Go to evil .Com", ""],
    ["Go to evil\u3002com", ""],
    ["Go to evil\uFF0Ecom", ""],
    ["Go to evil.\u200Bcom", ""],
    ["Go to \u0435vil d\u043Et com", ""],
    ["Book at cme.com", "Book at https://acme.com/book"],
    ["Book at acme.com", "Book at https://acme.com/book"],
    ["Book at https://acme.com/boo", "Book at https://acme.com/book"],
  ])("refuses %j", (text, instruction) => {
    expect(refusedTokens(text, [instruction])).not.toEqual([]);
  });

  it.each([
    ["Hi Thandi, Velocity Fibre here. Keen on a quote?", ""],
    ["Hi Thandi, can we chat at a time that suits you?", ""],
    ["Book at https://acme.com/book.", "Book at https://acme.com/book"],
    ["Mail INFO@acme.co.za", "Write to info@acme.co.za"],
    ["Call 082 123 4567 today", "Ask them to call 082 123 4567"],
    ["Acme.co here, keen on a quote?", "Acme.co"],
  ])("allows %j", (text, instruction) => {
    expect(refusedTokens(text, [instruction])).toEqual([]);
  });
});

describe("refusedTokens: homoglyphs, digits, URL case", () => {
  const ALLOWED = "Book at https://acme.com/Book?ref=SMS";

  it("compares tokens unfolded: a Cyrillic look-alike of an allowed link is refused", () => {
    expect(refusedTokens("Book at https://\u0430cme.com/Book?ref=SMS", [ALLOWED])).not.toEqual([]);
    expect(refusedTokens("Book at https://acme.com/Book?ref=SMS", [ALLOWED])).toEqual([]);
    // ...and the other way round: the instruction's own look-alike is not the Latin link.
    expect(refusedTokens("Visit acme.com today", ["Visit \u0430cme.com"])).not.toEqual([]);
  });

  it("refuses any non-Latin letter outside the exact business and first name", () => {
    expect(refusedTokens("Hi Thandi, \u043F\u0440\u0438\u0432\u0435\u0442?", [""])).toContain("non_latin_letters");
    expect(refusedTokens("Hi \u041E\u043B\u0435\u0433, keen on a quote?", [""], ["\u041E\u043B\u0435\u0433"])).toEqual([]);
    expect(refusedTokens("\u0412\u0435\u043B\u043E here, keen on a quote?", [""], ["\u0412\u0435\u043B\u043E"])).toEqual([]);
    // A name only exempts itself, matched exactly.
    expect(refusedTokens("Hi \u041E\u043B\u0435\u0433\u0430, keen?", [""], ["\u041E\u043B\u0435\u0433"])).toContain("non_latin_letters");
  });

  it.each([
    ["Call 082 ~ 123 ~ 4567 today"],
    ["Call 082_123_4567 today"],
    ["Ref a1~2~3~4~5~6~7 today"],
    ["Call \u0660\u0668\u0662\u0661\u0662\u0663\u0664\u0665\u0666\u0667 today"],
    ["Call \u0966\u096E\u0968 \u0967\u0968\u0969 today"],
    ["Call oh eight two one two three four five six seven"],
    ["Call zero eight two, one two three, four five six seven"],
    ["Call 0 eight 2 one 2 three 4"],
  ])("refuses a phone number however it is written: %j", (text) => {
    expect(refusedTokens(text, [""])).not.toEqual([]);
  });

  it("leaves a few spelled-out numbers and words that contain them alone", () => {
    expect(refusedTokens("Hi Thandi, one quick question. Is someone home on Monday?", [""])).toEqual([]);
  });

  it("lowercases only the scheme and host; the path and query must match exactly", () => {
    expect(refusedTokens("Book at HTTPS://ACME.com/Book?ref=SMS", [ALLOWED])).toEqual([]);
    expect(refusedTokens("Book at https://acme.com/book?ref=SMS", [ALLOWED])).not.toEqual([]);
    expect(refusedTokens("Book at https://acme.com/Book?ref=sms", [ALLOWED])).not.toEqual([]);
    expect(refusedTokens("Book at acme.com/BOOK", ["Book at acme.com/book"])).not.toEqual([]);
  });
});

describe("opt-out wording", () => {
  it.each([
    ['Want a quote? Reply "STOP" to unsubscribe.', "Want a quote?"],
    ["To opt out, reply STOP. Want a quote?", "Want a quote?"],
    ["Want a quote? STOP to opt out", "Want a quote?"],
    ["Want a quote? Respond STOP to end.", "Want a quote?"],
    ["We can send stop-gap routers. Want one?", "We can send stop-gap routers. Want one?"],
  ])("strips only whole opt-out sentences: %j", (text, expected) => {
    expect(stripOptOutSentences(text)).toBe(expected);
  });

  it("finds opt-out wording left mid-sentence, not in a hyphenated word", () => {
    expect(hasOptOutWording("You can stop these any time.")).toBe(true);
    expect(hasOptOutWording("Opt-out is easy.")).toBe(true);
    expect(hasOptOutWording("We sell stop-gap and non-stop plans.")).toBe(false);
  });
});

describe("normalising and segments", () => {
  it("drops format and astral characters and collapses separators", () => {
    expect(normaliseSmsText("Hi\u200B Thandi \u{1F600}\u2028there\u00AD")).toBe("Hi Thandi there");
  });

  it("cleanOpener strips markers and markdown", () => {
    expect(cleanOpener('"**Hi** [[book]] Thandi"')).toBe("Hi Thandi");
  });

  it("counts UCS-2 segments in UTF-16 units", () => {
    expect(exactSmsSegments("\u00EA".repeat(70))).toBe(1);
    expect(exactSmsSegments("\u{1F600}".repeat(36))).toBe(2);
  });

  it("fits the body and the suffix together", () => {
    const fitted = fitWithSuffix("word ".repeat(100).trim(), " Reply STOP to opt out.", 2);
    expect(exactSmsSegments(`${fitted} Reply STOP to opt out.`)).toBe(2);
  });
});
