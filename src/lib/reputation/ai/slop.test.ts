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

  it("a rule the guidelines also match is not applied; the others still are", () => {
    const guidelines = "Always sign off: Cheers! The Fixture Team";
    expect(slopHit("Thanks Sam. Cheers! The Fixture Team", guidelines)).toBeNull();
    expect(slopHit("We're thrilled. Cheers! The Fixture Team", guidelines)).toBe("thrilled");
    expect(slopHit("Thanks Sam!", null)).toBe("exclamation");
  });
});
