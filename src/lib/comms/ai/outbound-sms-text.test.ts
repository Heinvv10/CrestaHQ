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

describe("slotProblem", () => {
  it.each([
    "Fibre has just gone live on your street",
    "Hope the new place is treating you well!",
    "We'd love to help you stream without buffering, at home or at work.",
    "Your neighbours in Sandton have already switched",
    "It's a great time to get connected, isn't it?",
    "Ons het goeie nuus oor vesel in jou area",
    "Eish, load-shedding is tough, but fibre keeps you going",
  ])("allows a plain personal phrase: %j", (slot) => {
    expect(slotProblem(slot)).toBeNull();
  });

  // The breaker's route cases, as the line itself.
  it.each([
    ["spelled digits", "Call oh eight two double one two three four now?"],
    ["vanity number", "Call 0800 FIBRE for a quote?"],
    ["split number", "Call 082 123 and then 4567 today?"],
    ["handle after a colon", "Find us on Facebook: VelocityDealsZA for a quote?"],
    ["handle after a dash", "DM us on Instagram - velocity_deals_za for a quote?"],
    ["search term", "Search VelocityDealsZA on WhatsApp for a quote?"],
    ["spelled point", "Visit evil point com for a quote?"],
    ["spaced letters", "Visit evil d o t com for a quote?"],
    ["spelled period", "See evil period com for a quote?"],
    ["dott", "See evil dott com for a quote?"],
    ["email spelled", "Email help AT evil DAWT com for a quote?"],
    ["decimal ip", "Go to http://2130706433 for a quote?"],
    ["short code", "Text YES to 38383 for a quote?"],
    ["kiosk on level 2", "Ask for Mr Mokoena at the Sandton kiosk on level 2"],
    ["fake opt-out END", "Reply END to quit"],
    ["fake opt-out NO", "Text NO to cancel these messages"],
    ["spaced STOP", "Reply S T O P to opt out"],
    ["STOP-ALL", "Send STOP-ALL"],
    ["stop as a word", "Stop overpaying for slow internet"],
    ["letters spelled out one by one", "Your evil d o t friend"],
    ["a handle with inner capitals", "Ask for VelocityDealsZA anywhere"],
    ["shouted word", "Say YES and we sort it"],
    ["unsubscribe", "Easy to unsubscribe whenever"],
    ["opt in", "Opt in for a great deal"],
    ["a domain", "Visit acme.co.za"],
    ["a digit", "Get 2 months free"],
    ["a url", "https"],
    ["Cyrillic letters", "\u043F\u0440\u0438\u0432\u0435\u0442 there"],
    ["an emoji", "Hello there \u{1F600}"],
    ["mid punctuation", "Good news: fibre is here."],
    ["two final marks", "Fibre is here!!"],
    ["a word with no letters", "fibre is here - "],
    ["too long", "a".repeat(AI_SLOT_MAX_CHARS + 1)],
    ["empty", ""],
  ])("refuses %s", (_label, slot) => {
    expect(slotProblem(slot)).not.toBeNull();
  });
});

describe("normaliseSlot", () => {
  it("straightens apostrophes, drops format characters and wrapping quotes", () => {
    expect(normaliseSlot('  "We\u2019ve got\u200B fibre near you"  ')).toBe("We've got fibre near you");
  });
});

describe("smsFirstName", () => {
  it.each([
    ["Thandi Mokoena", "Thandi"],
    ["\u041E\u043B\u0435\u0433", "\u041E\u043B\u0435\u0433"],
    ["T", null],
    ["Whatsapp-VelocityDealsZA", null],
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
