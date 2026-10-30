import { describe, expect, it } from "vitest";
import {
  AI_SLOT_MAX_CHARS,
  OPT_OUT_SUFFIX,
  assembleAiSms,
  exactSmsSegments,
  normaliseSlot,
  slotProblem,
  smsFirstName,
  templateProblem,
} from "./outbound-sms-text";

/** The Send AI text template, the AI's slot and how they are put together. */

const TEMPLATE = "Hi {{firstName}}, it's {{business}}. {{ai}} Shall we send a quote?";

describe("templateProblem", () => {
  it("accepts a template with one {{ai}} and the known placeholders", () => {
    expect(templateProblem(TEMPLATE)).toBeNull();
  });

  it.each([["{{ai}}"], 42, { text: "{{ai}}" }, null])("refuses a template that isn't text: %j", (template) => {
    expect(templateProblem(template)).toBe("The template must be text.");
  });

  it.each([
    ["", /Write the message/],
    ["Hi {{firstName}}, want a quote?", /needs one \{\{ai\}\}/],
    ["{{ai}} and {{ai}}", /only one/],
    ["Hi {{contact.email}} {{ai}}", /isn't available here/],
    [`${"x".repeat(290)} {{ai}}`, /too long/],
  ])("refuses %j", (template, message) => {
    expect(templateProblem(template)).toMatch(message);
  });
});

describe("slotProblem (after normaliseSlot)", () => {
  const problem = (raw: string) => slotProblem(normaliseSlot(raw));

  // The breaker's typical personalised lines: none may be refused. (Its "Is
  // your signal giving you trouble?" now is: "signal" is a channel word.)
  it.each([
    "Hope your new home is settling in well!",
    "Hope you're having a great week.",
    "Saw you were looking at fibre for your home in Pretoria.",
    "Hope load shedding isn't giving you grief",
    "Thanks for your interest in our uncapped packages.",
    "Great options for your family are available",
    "Optical fibre is now live on your street",
    "Fast, reliable fibre is now available in Centurion.",
    "Happy Heritage Day to you and your family!",
    "Congrats on the new baby, Thandi!",
    "We would love to get you connected",
    "Our technician can come on site this week",
    "Follow up on your enquiry about fibre",
    "Thanks for your message about fibre",
    "We tried to call you earlier about your enquiry",
    "Fibre is now live in uMhlanga",
    "Great news for homes in KwaZulu-Natal",
    "Fibre is live in eThekwini",
    "Work from home just got easier with fibre",
    "Streaming DStv Stream and Netflix just got smoother",
    "Goeie dag, ons het vesel in jou area",
    "Sawubona, sine-fibre endaweni yakho",
    "Hope you're well. We have fibre in your area now.",
    "Your street is now covered \u2014 want faster internet?",
    "Looking for the best uncapped option for your home?",
    "Never worry about slow internet again",
    "Perfect for working online from home",
    "Mr. Botha, your street is now covered",
    "Fibre from a local provider you can trust",
    "Say goodbye to buffering",
    "Hope you're enjoying the long weekend with the family :)",
    "Fancy a coffee at the caf\u00e9 while we install?",
    "Ask for VelocityDealsZA anywhere",
    "One or two options might suit you",
    "We adopted a stopwatch approach to installs",
  ])("allows %j", (slot) => {
    expect(problem(slot)).toBeNull();
  });

  it.each<[string, string, RegExp]>([
    // The breaker's slot failures the rules are for.
    ["spelled phone", "Zero eight two one two three four five six seven", /number words/],
    ["spelled phone, commas", "On oh eight two, one two three, four five six seven", /number words/],
    ["three number words", "oh one two", /number words/],
    ["small caps STOP", "\uA731\u1D1B\u1D0F\u1D18", /characters other than/],
    ["a digit", "Get 2 months free", /characters other than/],
    ["an emoji", "Hello there \u{1F600}", /characters other than/],
    ["Cyrillic", "\u043f\u0440\u0438\u0432\u0435\u0442 there", /characters other than/],
    ["an accented stop", "send st\u00f3p to cancel", /opt-out word/],
    ["accented reply stop", "r\u00ebply st\u00f3p", /opt-out word/],
    ["accented whatsapp", "wh\u00e0tsapp us", /channel or a destination/],
    ["remove me", "say remove me to be taken off our list", /opt-out word/],
    ["quit", "send quit to cancel", /opt-out word/],
    ["unsub", "just unsub whenever", /opt-out word/],
    ["opt-out", "easy opt-out anytime", /opt-out word/],
    ["optout", "optout anytime", /opt-out word/],
    ["opt out as a phrase", "you can opt out anytime", /"opt out"/],
    ["a route word", "find us on whatsapp", /channel or a destination/],
    ...["linkedin", "messenger", "snapchat", "viber", "wechat", "skype", "discord", "signal"].map(
      (w): [string, string, RegExp] => [`channel ${w}`, `find us on ${w} today`, /channel or a destination/],
    ),
    ["a route word inside a hyphenated word", "join our insta-friends", /channel or a destination/],
    ["a hyphenated route word", "drop us an e-mail", /channel or a destination/],
    ["co", "velocitydeals co", /channel or a destination/],
    ["spelled url", "bit ly slash promo", /channel or a destination/],
    ["dot", "evil dot org", /channel or a destination/],
    ["punctuation inside a word", "great.news for you", /inside a word/],
    ["a colon", "Good news: fibre is here", /":" or "\)"/],
    ["a bracket", "fibre (finally) is here", /characters other than/],
    ["three sentences", "Hi. Hello. Hey.", /more than two sentences/],
    ["spaced letters", "Your evil d o t friend", /three single letters/],
    ["too long", "a".repeat(AI_SLOT_MAX_CHARS + 1), /longer than/],
    ["empty", "", /empty/],
  ])("refuses %s", (_label, slot, reason) => {
    expect(problem(slot)).toMatch(reason);
  });
});

describe("normaliseSlot", () => {
  it("drops accents and format characters, straightens apostrophes and dashes, drops wrapping quotes", () => {
    expect(normaliseSlot('  "We\u2019ve got\u200b fibre \u2014 caf\u00e9 too"  ')).toBe("We've got fibre - cafe too");
  });
});

describe("smsFirstName", () => {
  it.each([
    ["Thandi Mokoena", "Thandi"],
    ["Zo\u00eb", "Zoe"],
    ["\u0418\u0432\u0430\u043d", null],
    ["Jean-Luc", null],
    ["Abcdefghijklmnopqrstu", null],
    ["T", null],
    ["Whatsapp", null],
    ["STOP", null],
    ["082123", null],
    ["", null],
  ])("%j -> %j", (name, expected) => {
    expect(smsFirstName(name)).toBe(expected);
  });
});

describe("assembleAiSms", () => {
  it("fills the slot, the name and the business, then the opt-out line", () => {
    expect(assembleAiSms({ template: TEMPLATE, slot: "Fibre is live on your street.", firstName: "Thandi", business: "Velocity Fibre" }))
      .toBe(`Hi Thandi, it's Velocity Fibre. Fibre is live on your street. Shall we send a quote?${OPT_OUT_SUFFIX}`);
  });

  it("without a line, closes the gap; without a first name, says 'there'", () => {
    expect(assembleAiSms({ template: TEMPLATE, slot: null, firstName: null, business: "Velocity Fibre" }))
      .toBe(`Hi there, it's Velocity Fibre. Shall we send a quote?${OPT_OUT_SUFFIX}`);
  });

  it("never reads what it put in as a placeholder: braces are dropped from the business name", () => {
    const text = assembleAiSms({ template: TEMPLATE, slot: "Nice line", firstName: "Thandi", business: "Acme {{ai}} {{firstName}} $& $1" });
    expect(text).toBe(`Hi Thandi, it's Acme ai firstName $& $1. Nice line Shall we send a quote?${OPT_OUT_SUFFIX}`);
    expect(text).not.toContain("{{");
  });

  it("puts the operator's text through verbatim", () => {
    const template = "Visit https://acme.co.za/Book or call 082 123 4567. {{ai}}";
    expect(assembleAiSms({ template, slot: "See you soon", firstName: null, business: "Acme" }))
      .toBe(`Visit https://acme.co.za/Book or call 082 123 4567. See you soon${OPT_OUT_SUFFIX}`);
  });
});

describe("exactSmsSegments", () => {
  it("counts UCS-2 in UTF-16 units", () => {
    expect(exactSmsSegments("\u00EA".repeat(70))).toBe(1);
    expect(exactSmsSegments("\u{1F600}".repeat(36))).toBe(2);
  });
});
