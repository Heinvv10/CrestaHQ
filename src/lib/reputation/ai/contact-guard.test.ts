import { describe, expect, it } from "vitest";

import { unsuppliedContact } from "./contact-guard";

/**
 * The draft's contact guard (SP5 c): an AI draft must carry no phone number,
 * email, link, domain, USSD code, social handle or platform the business's
 * guidelines did not supply — however it is written. Each bypass below was
 * listed by the blind review; each must be caught. Allowed contacts are
 * matched as EXACT tokens, never as substrings of the guidelines.
 */

const refused = (text: string, guidelines: string | null = null) => unsuppliedContact(text, guidelines);

describe("refuses every written form of a contact", () => {
  it.each([
    ["full-width digits", "Call ０８２ １２３ ４５６７ for help."],
    ["Arabic-Indic digits", "Call ٠٨٢١٢٣٤٥٦٧ for help."],
    ["superscript digits (compatibility forms only NFKC folds)", "Call ⁰⁸² ¹²³ ⁴⁵⁶⁷ for help."],
    ["circled digits", "Call ⓪⑧② ①②③ ④⑤⑥⑦ for help."],
    ["slashes", "Call 082/123/4567 for help."],
    ["underscores", "Call 082_123_4567 for help."],
    ["spaces and brackets", "Call (082) 123 4567."],
    ["dashes", "Call 082-123-4567."],
    ["a USSD code", "Dial *120*555# to claim."],
    ["scam.ai", "See scam.ai for your refund."],
    ["refund.de", "Visit refund.de today."],
    ["is.gd/abc", "Short link: is.gd/abc"],
    ["goo.gl/xyz", "Details at goo.gl/xyz."],
    ["evil.page", "Read evil.page"],
    ["evil.cloud", "Read evil.cloud"],
    ["an IDN domain", "Смотрите пример.рф"],
    ["spaced dots", "Go to example . com now."],
    ["[.]", "Go to example[.]com now."],
    ["(dot)", "Go to example (dot) com now."],
    ["' dot '", "Go to example dot com now."],
    ["[at] and [dot]", "Write to info [at] example [dot] com."],
    ["(at)", "Write to info (at) example.com."],
    ["an ideographic full stop", "Go to example。com now."],
    ["a half-width ideographic full stop", "Go to example｡com now."],
    ["a full-width full stop", "Go to example．com now."],
    ["a zero-width space", "Go to evil​.com now."],
    ["a zero-width joiner inside the name", "Go to ev‍il.com now."],
    ["a social handle", "DM us on instagram @fixturerefunds"],
    ["a bare handle", "Message @fixturerefunds for a refund."],
    ["a platform name", "Find us on TikTok."],
    ["an email", "Email help@evil.example."],
    ["a URL", "See https://evil.example/x"],
    ["a www link", "See www.evil.example"],
  ])("%s", (_label, text) => {
    expect(refused(text)).not.toBeNull();
  });
});

describe("leaves ordinary prose alone", () => {
  it.each([
    "Thank you, e.g. for the kind words.",
    "That is, i.e. the install team.",
    "Speeds of 1.5 Gbps and 2.25 times faster.",
    "See you at 9 a.m. on Monday.",
    "The U.S.A. team says thanks.",
    "Thanks for your 5-star review!",
    "We fixed it within 24 hours — sorry about the wait.",
    "Order 12345 is on its way.",
    "Warm regards, The Fixture Team.",
    "We're sorry. We'll do better.",
  ])("%s", (text) => {
    expect(refused(text)).toBeNull();
  });
});

describe("what the guidelines supply is allowed — as exact tokens only", () => {
  const G = "Our site is fixturefibre.co.za, email help@fixturefibre.co.za, call 041 000 0000, dial *120*777#, Instagram @fixturefibre.";

  it("allows each supplied contact, in any written form", () => {
    expect(refused("More at fixturefibre.co.za.", G)).toBeNull();
    expect(refused("More at https://fixturefibre.co.za/help", G)).toBeNull();
    expect(refused("Email help@fixturefibre.co.za.", G)).toBeNull();
    expect(refused("Call ０４１ ０００ ００００.", G)).toBeNull();
    expect(refused("Call 041-000-0000.", G)).toBeNull();
    expect(refused("Dial *120*777#.", G)).toBeNull();
    expect(refused("More at ｆｉｘｔｕｒｅｆｉｂｒｅ.co.za.", G)).toBeNull();
    expect(refused("Follow us on Instagram @fixturefibre.", G)).toBeNull();
  });

  it.each([
    ["a domain that is a prefix of the supplied one", "More at fixturefibre.co."],
    ["an email on that prefix domain", "Email help@fixturefibre.co now."],
    ["a phone number that is a prefix of the supplied one", "Call 041 000 000 today."],
    ["a phone number that extends the supplied one", "Call 041 000 00001 today."],
    ["another handle", "Follow @fixturefibre_deals."],
    ["another platform", "Find us on TikTok."],
  ])("refuses %s", (_label, text) => {
    expect(refused(text, G)).not.toBeNull();
  });
});
