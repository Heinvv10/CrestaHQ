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
    ["Go to evil dot com", ""],
    ["Go to evil[.]com", ""],
    ["Go to evil (dot) com", ""],
    ["Go to hxxp evil", ""],
    ["Go to evil . com", ""],
    ["Go to evil. com", ""],
    ["Go to evil。com", ""],
    ["Go to evil．com", ""],
    ["Go to evil.​com", ""],
    ["Go to еvil dоt com", ""],
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
    expect(normaliseSmsText("Hi​ Thandi \u{1F600} there­")).toBe("Hi Thandi there");
  });

  it("cleanOpener strips markers and markdown", () => {
    expect(cleanOpener('"**Hi** [[book]] Thandi"')).toBe("Hi Thandi");
  });

  it("counts UCS-2 segments in UTF-16 units", () => {
    expect(exactSmsSegments("ê".repeat(70))).toBe(1);
    expect(exactSmsSegments("\u{1F600}".repeat(36))).toBe(2);
  });

  it("fits the body and the suffix together", () => {
    const fitted = fitWithSuffix("word ".repeat(100).trim(), " Reply STOP to opt out.", 2);
    expect(exactSmsSegments(`${fitted} Reply STOP to opt out.`)).toBe(2);
  });
});
