import { describe, expect, it } from "vitest";
import { aiHook, aiQuestions, areaCount, rankedFindings, trafficLight, whatsappHref } from "./report-story";
import type { PublicReportSection } from "./public-sections";

const s = (key: PublicReportSection["key"], over: Partial<PublicReportSection> = {}): PublicReportSection => ({
  key, status: "ok", score: 100, findings: [], reason: null, reasonCode: null, details: {}, ...over,
});
const f = (code: PublicReportSection["findings"][number]["code"], text = code) => ({ code, text, impact: null, cta: null });

describe("trafficLight", () => {
  it("100 is good, 50–99 needs work, under 50 is poor", () => {
    expect([100, 99, 50, 49, 0].map(trafficLight)).toEqual(["good", "needsWork", "needsWork", "poor", "poor"]);
  });
});

describe("rankedFindings", () => {
  it("ranks by SEVERITY_ORDER across sections and skips unmeasured sections", () => {
    const ranked = rankedFindings([
      s("reputation", { findings: [f("reviews_under_50"), f("low_rating")] }),
      s("business_details", { status: "timeout", findings: [f("no_website")] }),
      s("ai_presence", { findings: [f("not_in_ai_answers")] }),
    ]);
    expect(ranked.map((x) => [x.section, x.code])).toEqual([
      ["ai_presence", "not_in_ai_answers"],
      ["reputation", "low_rating"],
      ["reputation", "reviews_under_50"],
    ]);
  });
});

describe("areaCount", () => {
  it("counts scored ok sections, and those among them with findings", () => {
    expect(
      areaCount([
        s("gbp", { score: 65, findings: [f("gbp_no_hours")] }),
        s("reputation"),
        s("listings", { score: null }),
        s("tech_stack", { status: "failed", score: null }),
      ]),
    ).toEqual({ needWork: 1, scored: 2 });
  });
});

describe("aiHook", () => {
  const ai = s("ai_presence", {
    score: 0,
    findings: [f("not_in_ai_answers")],
    details: { question2: "second", question1: "first", mentionedIn: 0, answersMeasured: 6, topCompetitors: "A, B" },
  });
  it("returns the first question and counts when the headline is AI presence", () => {
    expect(aiQuestions(ai)).toEqual(["first", "second"]);
    expect(aiHook([ai], rankedFindings([ai])[0]!)).toEqual({ question: "first", competitors: "A, B", mentioned: 0, measured: 6 });
  });
  it("is null when the headline is another section, or the report has no questions", () => {
    const gbp = s("gbp", { findings: [f("no_website")] });
    expect(aiHook([ai, gbp], rankedFindings([ai, gbp])[0]!)).toBeNull();
    const old = { ...ai, details: { mentionedIn: 0, answersMeasured: 6 } };
    expect(aiHook([old], rankedFindings([old])[0]!)).toBeNull();
    expect(aiHook([ai], null)).toBeNull();
  });
});

describe("whatsappHref", () => {
  it("links the digits of the number, and is null without one", () => {
    expect(whatsappHref("+27 82 000 0000")).toBe("https://wa.me/27820000000");
    expect(whatsappHref(null)).toBeNull();
    expect(whatsappHref("")).toBeNull();
  });
});
