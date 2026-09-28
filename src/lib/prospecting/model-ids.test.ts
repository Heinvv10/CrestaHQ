import { describe, expect, it } from "vitest";
import { apexgeoFromScan } from "./apexgeo-sections";
import { completedScan } from "./apexgeo.fixture";
import { publicSection } from "./public-sections";
import { FINDING_COPY } from "./sections/findings";
import { headline } from "./severity";

/**
 * C4: a model id never reaches stored finding text, the headline (and so
 * `lastReportHeadline` / `{{prospecting.headline}}`) or the public view. The
 * models are kept in `raw.models` for the member view only.
 */

const scan = completedScan();
const MODEL_IDS = [...new Set(scan.ai_visibility.prompts.flatMap((p) => p.engines.map((e) => e.model)))];
/** Beyond the fixture's: any id shaped like a provider's model name. */
const MODEL_ID_SHAPE = /\b(gpt-\d|gemini-\d|claude-\d|sonar\b|llama-?\d|mistral)/i;

function assertNoModelId(text: string) {
  for (const id of MODEL_IDS) expect(text).not.toContain(id);
  expect(text).not.toMatch(MODEL_ID_SHAPE);
}

const variants = {
  "none named": completedScan(),
  "named in some": (() => {
    const s = completedScan();
    s.ai_visibility.prompts[0].engines[0].mentioned = true;
    return s;
  })(),
};

describe("no model id in stored or public text (C4)", () => {
  it("the fixture's model ids are what the check looks for", () => {
    expect(MODEL_IDS).toEqual(["gemini-2.5-flash", "sonar", "gpt-4o-mini"]);
  });

  it.each(Object.entries(variants))("%s: finding text, impact, CTA and headline", (_label, s) => {
    const sections = apexgeoFromScan(s as never);
    const findings = sections.flatMap((x) => x.findings);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) assertNoModelId(`${f.text} ${f.impact} ${f.cta}`);
    assertNoModelId(String(headline(sections)));
    expect(sections.find((x) => x.key === "ai_presence")!.findings[0].text).toMatch(/^AI assistants like ChatGPT and Gemini /);
  });

  it.each(Object.entries(variants))("%s: the public view", (_label, s) => {
    assertNoModelId(JSON.stringify(apexgeoFromScan(s as never).map((x) => publicSection(x, { showName: true }))));
  });

  it("the stored copy table", () => {
    assertNoModelId(JSON.stringify(FINDING_COPY));
  });
});
