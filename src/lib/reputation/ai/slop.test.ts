import { describe, expect, it } from "vitest";
import { SLOP_RULES, slopHit } from "./slop";

/** The draft voice check: every rule fires on its tell, and near-misses stay clean. */

const HITS: Array<[string, string]> = [
  ["exclamation", "Thanks Sam!"],
  ["emoji", "Thanks Sam 😊"],
  ["emoji", "Thanks Sam 👍"],
  ["dash", "Thanks Sam — glad it worked."],
  ["dash", "Thanks Sam – glad it worked."],
  ["thrilled", "We are Thrilled it went well."],
  ["delighted", "Delighted to hear it."],
  ["truly", "We truly care."],
  ["genuinely", "We genuinely care."],
  ["appreciate_your_support", "We appreciate your support."],
  ["dont_hesitate", "Don't hesitate to ask."],
  ["dont_hesitate", "Don’t hesitate to ask."],
  ["dont_hesitate", "Please do not hesitate to ask."],
  ["reach_out", "Please reach out any time."],
  ["look_forward_to", "We look forward to serving you."],
  ["look_forward_to", "Looking forward to welcoming you back."],
  ["look_forward_to", "We look forward to helping again."],
  ["fifth_star", "What would earn that fifth star?"],
  ["fifth_star", "Tell us how to earn the 5th star."],
  ["valued_customer", "You are a valued customer."],
  ["valued_customer", "Our valued customers come first."],
  ["value_your_feedback", "We value your feedback."],
  ["means_the_world", "It means the world to us."],
  ["rest_assured", "Rest assured we will fix it."],
  ["above_and_beyond", "The team went above and beyond."],
  ["wonderful_review", "Thanks for the wonderful review."],
  ["kind_words", "Thanks for the kind words."],
  ["so_glad", "We're so glad it worked."],
  ["so_glad", "We are so glad it worked."],
];

const CLEAN = [
  "Thanks Sam. Glad the team left everything neat.",
  "Thanks Lee. Good to hear it went quickly.",
  "Sorry about the missed appointment, Jo. That shouldn't happen, and we've passed it to the team.",
  "Thanks. We appreciate it.",
  "Glad the install went well.",
  "The technician reached the house early.",
  "We reached rural customers too.",
  "Our outreach team called.",
  "We look forward to it.",
  "The star of the show was Lee.",
  "We value you.",
  "Truthfully, it was quick.",
  "A kind word goes far.",
  "We're glad it worked.",
  "Well-done install, 3-4 days early.",
];

describe("slopHit", () => {
  it.each(HITS)("%s fires on %j", (id, text) => {
    expect(slopHit(text)).toBe(id);
  });

  it.each(CLEAN)("near-miss %j is clean", (text) => {
    expect(slopHit(text)).toBeNull();
  });

  it("every rule in the list has a hit case (a new rule needs a test)", () => {
    const tested = new Set(HITS.map(([id]) => id));
    expect(SLOP_RULES.map((r) => r.id).filter((id) => !tested.has(id))).toEqual([]);
  });

  it("returns the FIRST rule in list order", () => {
    expect(slopHit("We are thrilled!")).toBe("exclamation");
  });

  it("the business's reply guidelines never switch a rule off (there is no guidelines argument)", () => {
    // The production guidelines name the very tells they ban; a draft using them is still slop.
    expect(slopHit("We're thrilled. Don't hesitate to reach out.")).toBe("thrilled");
    expect(slopHit.length).toBeLessThanOrEqual(1);
  });
});

/* Bypasses a model (or a review steering it) could use: every one is caught after normalisation. */
const BYPASSES: Array<[string, string]> = [
  ["exclamation", "Thanks Sam\uFF01"],
  ["exclamation", "\u00A1Thanks Sam."],
  ["exclamation", "Thanks Sam\u203C"],
  ["exclamation", "Thanks Sam\u2049"],
  ["dash", "Thanks Sam \u2015 glad it worked."],
  ["dash", "Thanks Sam \u2012 glad it worked."],
  ["dash", "Thanks Sam \u2E3A glad it worked."],
  ["dash", "Thanks Sam \uFE58 glad it worked."],
  ["dash", "Thanks Sam - glad it worked."],
  ["dash", "Thanks Sam -- glad it worked."],
  ["dash", "Thanks Sam--glad it worked."],
  ["thrilled", "We are thr\u200Dilled it worked."],
  ["reach_out", "Please reach\u200B out any time."],
  ["genuinely", "We genu\u00ADinely care."],
  ["delighted", "D\u0435lighted to hear it."],
  ["delighted", "D\u03B5lighted to hear it."],
  ["truly", "We \uFF54\uFF52\uFF55\uFF4C\uFF59 care."],
  ["look_forward_to", "We l\u03BF\u03BFk forward to serving you."],
  ["appreciate_your_support", "We \u03B1ppreciate your support."],
  ["valued_customer", "You are a \u03BDalued customer."],
  ["rest_assured", "R\u0435st \u0430ssur\u0435d, it is fixed."],
  ["genuinely", "We g\u0435nu\u0456n\u0435ly care."],
  ["emoji", "Thanks Sam \u{1F1FF}\u{1F1E6}"],
  ["emoji", "Thanks Sam :)"],
  ["emoji", "Thanks Sam :-)"],
  ["emoji", "Thanks Sam :D"],
  ["emoji", "Thanks Sam ;)"],
];

const STAYS_CLEAN = [
  "Fixture Fibre\u00A9 installs the line.",
  "Fixture Fibre\u00AE installs the line.",
  "Fixture Fibre\u2122 installs the line.",
  "Patchy Wi-Fi is a router matter.",
  "Thanks for the rating-only review.",
  "The office is open 08:00\u201317:00 on weekdays.",
  "It usually takes 5\u201310 days.",
  "Thanks Theo. Glad the installation team left everything neat and tidy.",
  "Dankie, Morn\u00E9. Goed om te hoor ons span was vriendelik en doeltreffend en dat jy ons kan aanbeveel.",
  "Thanks Hennie. We install and maintain the fibre line itself, so patchy Wi-Fi in certain rooms is usually a router or coverage matter for your internet provider.",
];

describe("slopHit after normalisation", () => {
  it.each(BYPASSES)("%s fires on %j", (id, text) => {
    expect(slopHit(text)).toBe(id);
  });

  it.each(STAYS_CLEAN)("%j stays clean", (text) => {
    expect(slopHit(text)).toBeNull();
  });

  it("an en or em dash between digits is a range; beside a word it is a dash", () => {
    expect(slopHit("Open 08:00\u201417:00.")).toBeNull();
    expect(slopHit("Open 08:00 \u2013 late.")).toBe("dash");
    expect(slopHit("Open late\u20135.")).toBe("dash");
  });
});

describe("slopHit ignores the reviewer's first name and the business name", () => {
  it("a reviewer called Truly and a business called Delighted Cleaning are not tells", () => {
    expect(slopHit("Thanks Truly. Delighted Cleaning is glad it went well.", ["Truly", "Delighted Cleaning"])).toBeNull();
    expect(slopHit("Thanks TRULY. glad it went well.", ["truly"])).toBeNull();
  });

  it("only the whole name is removed; the same word elsewhere, or in a longer word, still fires", () => {
    expect(slopHit("Thanks Truly. We genuinely care.", ["Truly"])).toBe("genuinely");
    expect(slopHit("Thanks Sam. We truly care.", ["Sam", "Truly Fibre"])).toBe("truly");
    expect(slopHit("Thanks Trulyanne.", ["Truly"])).toBeNull();
    expect(slopHit("We truly care, Trulyanne.", ["Trulyanne"])).toBe("truly");
    expect(slopHit("Delighted to help, from Delighted Cleaning.", ["Delighted Cleaning"])).toBe("delighted");
    expect(slopHit("Thanks Sam!", ["Sam"])).toBe("exclamation");
  });

  it("null and blank names are ignored; reach out, kind words, above and beyond stay banned even when innocent (fail safe)", () => {
    expect(slopHit("Please reach out to your internet provider.", [null, "", "  "])).toBe("reach_out");
    expect(slopHit("It was kind words from Lee that got us there.", ["Sam"])).toBe("kind_words");
    expect(slopHit("The cable runs above and beyond the gate.", ["Sam"])).toBe("above_and_beyond");
  });
});
