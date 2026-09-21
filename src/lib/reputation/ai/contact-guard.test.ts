import { describe, expect, it } from "vitest";

import { unsuppliedContact } from "./contact-guard";

/**
 * The draft's contact guard (SP5 c) — BEST-EFFORT: it catches the common ways
 * of writing a phone number, email, link, domain, USSD code, social handle or
 * platform the business's guidelines did not supply. A determined review can
 * still slip a contact past it; the control is the admin, who reads every
 * draft and must click Post. Allowed contacts match as EXACT tokens, never as
 * substrings of the guidelines. Each bypass below was listed by a blind review.
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
    ["a number ending in a year-like group", "Call 082 123 2019."],
    ["a number starting with a year-like group", "Call 2019 123 456 now."],
    ["a number behind an R (price mask)", "Call R082 123 9999 today."],
    ["a number behind ref (reference mask)", "Use ref 0821239999 to reach us."],
    ["a number behind # (reference mask)", "Reach us on #0821239999."],
    ["a number that starts like a time", "Or try 08:21 23 99 99 after hours."],
    ["a 9-digit number behind ref", "Use ref 082123999 to reach us."],
    ["a +27 number behind #", "Reach us on #27821239999."],
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
    ["number words", "Call oh eight two one two three four five six seven."],
    ["number words mixed with digits", "Call 082 one two three 4567."],
    ["a middle dot", "Go to evil·com now."],
    ["a katakana middle dot", "Go to evil・com now."],
    ["a comma between letters", "Go to evil,com now."],
    ["a space before the dot", "Go to evil .com now."],
    ["a space after the dot, lower case", "Go to evil. com now."],
    ["<dot>", "Go to evil<dot>com now."],
    ["<at> and <dot>", "Write info<at>evil<dot>com."],
    ["-dot-", "Go to evil-dot-com now."],
    ["_dot_", "Go to evil_dot_com now."],
    ["an underscored platform", "Find us on tik_tok."],
    ["ig", "DM us on IG."],
    ["Signal", "Message us on Signal."],
    ["Threads", "Follow us on Threads."],
    ["Discord", "Join our Discord."],
    ["tik tok", "Find us on tik tok."],
    ["whats app", "Message us on whats app."],
    ["a spaced USSD code", "Dial * 120 * 555 # to claim."],
    ["a USSD code without the last star", "Dial *120*555 # now."],
    ["a USSD code with a star before #", "Dial *120*555*# now."],
    ["a punycode domain", "See xn--e1afmkfd.xn--p1ai for details."],
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
    "Your visit on 12/09/2026 was noted.",
    "We came on 2026-09-12 at 14:30.",
    "We're open 08:00–17:00 on weekdays.",
    "The team is in from 9:30am–4:45pm on 14/09.",
    "Order #1234567 has shipped.",
    "Order 12345 and order 67890 are both on the way.",
    "Your Ref: INV-2026-00123 is closed.",
    "See ticket no. 2026091412 for the fix.",
    "The router costs R1 299,00 with installation.",
    "You paid R1 299.00 twice on 12 Sept 2026 — we've refunded it.",
    "Since 1998 we've been serving 20 000 homes.",
    "Upgrades from 25 Mbps to 1000 Mbps in 2024.",
    "Visit us at 14 Main Road, Randburg, 2196.",
    "We're open 07:30-18:00 every day.",
    "We're open 08:00-17.30 on weekdays.",
    "Thanks for staying with us, we appreciate it.",
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
    "Visit https://fixturefibre.co.za.",
    "Visit https://fixturefibre.co.za, or call us.",
    "More here (https://fixturefibre.co.za) today.",
    "Visit www.fixturefibre.co.za!",
    "See https://fixturefibre.co.za;",
    "Email help@fixturefibre.co.za!",
  ])("allows its own URL or email before punctuation: %s", (text) => {
    expect(refused(text, G)).toBeNull();
  });

  it("two numbers in the guidelines are two allowed numbers — however they are separated", () => {
    for (const g of ["Call 041 000 0000 or 082 123 4567.", "Lines: 041 000 0000 / 082 123 4567", "041 000 0000, 082 123 4567", "041 000 0000; 082 123 4567", "041 000 0000\n082 123 4567"]) {
      expect(refused("Call 082 123 4567.", g), g).toBeNull();
      expect(refused("Call 041 000 0000.", g), g).toBeNull();
      expect(refused("Call 083 999 8888.", g), g).not.toBeNull();
    }
  });

  it("+27 and a leading 0 are the same South African number", () => {
    expect(refused("Call +27 82 123 4567.", "Our line is 082 123 4567.")).toBeNull();
    expect(refused("Call 082 123 4567.", "Our line is +27 82 123 4567.")).toBeNull();
    expect(refused("Call +27 82 999 4567.", "Our line is 082 123 4567.")).not.toBeNull();
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
