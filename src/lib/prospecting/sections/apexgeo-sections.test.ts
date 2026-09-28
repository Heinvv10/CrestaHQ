import { describe, expect, it, vi } from "vitest";
import { allEnginesErrored, completedScan } from "../apexgeo.fixture";
import type { ApexgeoScan } from "../apexgeo-client";
import * as aiPresence from "./ai-presence";
import * as aiReadiness from "./ai-readiness";
import * as websitePerformance from "./website-performance";

/** Sections 5, 7 and 8 from the recorded ApexGEO payload, one branch per case. */

const scan = (mutate: (s: ReturnType<typeof completedScan>) => void = () => {}): ApexgeoScan => {
  const s = completedScan();
  mutate(s);
  return s as unknown as ApexgeoScan;
};
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe("section 5 — website performance", () => {
  it("the recorded scan (LCP 6.2s) is slow on mobile", () => {
    const r = websitePerformance.result(scan());
    expect(r).toMatchObject({ key: "website_performance", status: "ok", score: 30 });
    expect(codes(r)).toEqual(["slow_mobile"]);
    expect(r.findings[0].text).toContain("6.2s");
    expect(r.raw).toEqual({
      lcpSeconds: 6.2, fcpSeconds: 2.3, speedIndexSeconds: 6, tbtMs: 1166, cls: 0, mobileViewport: true,
    });
  });

  it.each([
    [2500, 100, []],
    [2501, 70, ["lcp_needs_improvement"]],
    [4000, 70, ["lcp_needs_improvement"]],
    [4001, 30, ["slow_mobile"]],
  ])("LCP %i ms scores %i", (lcp, expected, findings) => {
    const r = websitePerformance.result(scan((s) => void (s.technical.core_web_vitals.lcp_ms = lcp)));
    expect(r.score).toBe(expected);
    expect(codes(r)).toEqual(findings);
  });

  it("no mobile viewport costs 20 points; an unmeasured viewport costs nothing", () => {
    const fast = (v: boolean | null) =>
      scan((s) => {
        s.technical.core_web_vitals.lcp_ms = 2000;
        (s.technical as { mobile_viewport: boolean | null }).mobile_viewport = v;
      });
    expect(websitePerformance.result(fast(false))).toMatchObject({ score: 80 });
    expect(codes(websitePerformance.result(fast(false)))).toEqual(["no_mobile_viewport"]);
    expect(websitePerformance.result(fast(null))).toMatchObject({ score: 100, raw: { mobileViewport: "notMeasured" } });
  });

  it("a Core Web Vitals error is NOT measured — never slow", () => {
    const r = websitePerformance.result(
      scan((s) => {
        (s.technical as { core_web_vitals: unknown }).core_web_vitals = null;
        (s.technical as { core_web_vitals_error: unknown }).core_web_vitals_error = "PageSpeed timed out";
      }),
    );
    expect(r).toMatchObject({ status: "unavailable", score: null, findings: [] });
  });

  it("no technical block at all is unavailable", () => {
    expect(websitePerformance.result(scan((s) => void ((s as { technical: unknown }).technical = null))).status).toBe(
      "unavailable",
    );
  });
});

describe("section 7 — AI readiness", () => {
  it("the recorded scan: crawlers allowed, no LocalBusiness schema", () => {
    const r = aiReadiness.result(scan());
    expect(r).toMatchObject({ key: "ai_readiness", status: "ok", score: 70 });
    expect(codes(r)).toEqual(["no_local_business_schema"]);
    expect(r.raw).toEqual({
      localBusinessSchema: false, robotsTxt: "found",
      GPTBot: "allowed", ClaudeBot: "allowed", PerplexityBot: "allowed", "Google-Extended": "allowed",
    });
  });

  it.each(["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const)(
    "%s blocked raises ai_crawlers_blocked, naming it",
    (bot) => {
      const r = aiReadiness.result(
        scan((s) => {
          s.ai_readiness.robots[bot] = "blocked";
          s.ai_readiness.local_business_schema = true;
        }),
      );
      expect(r.score).toBe(40);
      expect(codes(r)).toEqual(["ai_crawlers_blocked"]);
      expect(r.findings[0].text).toContain(bot);
    },
  );

  it("Bingbot blocked is not an AI crawler", () => {
    const r = aiReadiness.result(
      scan((s) => {
        s.ai_readiness.robots.Bingbot = "blocked";
        s.ai_readiness.local_business_schema = true;
      }),
    );
    expect(r).toMatchObject({ score: 100, findings: [] });
  });

  it("an unreadable robots.txt (null per bot) is not measured, never blocked", () => {
    const r = aiReadiness.result(
      scan((s) => {
        for (const bot of Object.keys(s.ai_readiness.robots)) (s.ai_readiness.robots as Record<string, unknown>)[bot] = null;
        (s.ai_readiness as { robots_txt: unknown }).robots_txt = null;
        s.ai_readiness.local_business_schema = true;
      }),
    );
    expect(r).toMatchObject({ score: 100, findings: [] });
    expect(r.raw).toMatchObject({ GPTBot: "notMeasured", robotsTxt: "notMeasured" });
  });

  it("both problems: 10", () => {
    const r = aiReadiness.result(scan((s) => void (s.ai_readiness.robots.GPTBot = "blocked")));
    expect(r.score).toBe(10);
    expect(codes(r)).toEqual(["ai_crawlers_blocked", "no_local_business_schema"]);
  });

  it("no ai_readiness block is unavailable", () => {
    expect(aiReadiness.result(scan((s) => void ((s as { ai_readiness: unknown }).ai_readiness = null))).status).toBe(
      "unavailable",
    );
  });
});

describe("section 8 — AI presence", () => {
  it("the recorded scan: Perplexity errors are NOT measured; 6 answers, none naming the business", () => {
    const r = aiPresence.result(scan());
    expect(r).toMatchObject({ key: "ai_presence", status: "ok", score: 0 });
    expect(codes(r)).toEqual(["not_in_ai_answers"]);
    expect(r.findings[0].text).toContain("6 answers");
    expect(r.raw).toEqual({
      mentionedIn: 0,
      answersMeasured: 6,
      models: "gemini-2.5-flash, gpt-4o-mini",
      topCompetitors: "Alpha Plumbing, Beta Drains, Gamma Plumbing Exampletown",
      prompts: [
        { text: "best plumber in Exampletown", competitors: ["Alpha Plumbing", "Beta Drains", "Gamma Plumbing Exampletown"] },
        { text: "plumber near me in Exampletown, who should I call", competitors: ["Delta Plumbquick"] },
        {
          text: "recommended plumber Exampletown reviews",
          competitors: ["Alpha Plumbing", "Beta Drains", "Epsilon Electrical", "Zeta Plumbing"],
        },
      ],
    });
  });

  it("named in some answers is ai_mentions_partial; only measured answers count", () => {
    const r = aiPresence.result(
      scan((s) => {
        s.ai_visibility.prompts[0].engines[0].mentioned = true;
        // A mention inside an errored answer does not count.
        s.ai_visibility.prompts[1].engines[1].mentioned = true;
      }),
    );
    expect(r).toMatchObject({ score: 75, raw: { mentionedIn: 1, answersMeasured: 6 } });
    expect(codes(r)).toEqual(["ai_mentions_partial"]);
    expect(r.findings[0].text).toContain("1 of 6 answers");
  });

  it("named in every measured answer scores 100 with no finding", () => {
    const r = aiPresence.result(
      scan((s) => s.ai_visibility.prompts.forEach((p) => p.engines.forEach((e) => (e.mentioned = true)))),
    );
    expect(r).toMatchObject({ score: 100, findings: [] });
  });

  it("an engine that errored on SOME prompts leaves the question open: no not_in_ai_answers, and no score", () => {
    const r = aiPresence.result(
      scan((s) => void (s.ai_visibility.prompts[2].engines[2].error = "API error: timeout")),
    );
    expect(r).toMatchObject({ status: "ok", score: null, findings: [], raw: { answersMeasured: 5 } });
  });

  it("every engine errored: unavailable, never 'not mentioned'", () => {
    const r = aiPresence.result(allEnginesErrored() as unknown as ApexgeoScan);
    expect(r).toMatchObject({ status: "unavailable", score: null, findings: [] });
  });

  it("no ai_visibility block is unavailable", () => {
    expect(aiPresence.result(scan((s) => void ((s as { ai_visibility: unknown }).ai_visibility = null))).status).toBe(
      "unavailable",
    );
  });

  it("competitors: counted once per answer, case-insensitive, most-named first, top 3, blanks skipped", () => {
    const r = aiPresence.result(
      scan((s) => {
        s.ai_visibility.prompts[0].engines[2].competitors_named = ["zeta plumbing", "Zeta Plumbing", " "];
        s.ai_visibility.prompts[1].engines[2].competitors_named = ["ZETA PLUMBING"];
      }),
    );
    // Zeta 3 answers (shown as first spelled); Alpha 2, Beta 2 (seen before Gamma 1).
    expect(r.raw.topCompetitors).toBe("zeta plumbing, Alpha Plumbing, Beta Drains");
  });

  it("a name repeated inside one answer counts once; a blank name is never listed", () => {
    const r = aiPresence.result(
      scan((s) => {
        const lists = [["X Co", "x co", "X CO", "  "], ["Y Co"], ["Y Co", ""], [], [], []];
        s.ai_visibility.prompts.flatMap((p) => p.engines.filter((e) => e.error === null)).forEach((e, i) => {
          e.competitors_named = lists[i];
        });
      }),
    );
    expect(r.raw.topCompetitors).toBe("Y Co, X Co");
  });

  it("no competitors named → null, not an empty string", () => {
    const r = aiPresence.result(
      scan((s) => s.ai_visibility.prompts.forEach((p) => p.engines.forEach((e) => (e.competitors_named = [])))),
    );
    expect(r.raw.topCompetitors).toBeNull();
  });

  it("the answers' text and cited URLs never reach raw; each question keeps only its text and competitors (C7)", () => {
    const r = aiPresence.result(
      scan((s) => void (s.ai_visibility.prompts[0].engines[0].cited_url = "https://secret.example/x")),
    );
    const json = JSON.stringify(r);
    expect(json).not.toContain("secret.example");
    for (const p of r.raw.prompts as Record<string, unknown>[]) expect(Object.keys(p).sort()).toEqual(["competitors", "text"]);
  });
});

describe("section 8 — competitor filter (C5)", () => {
  const named = (names: string[], businessName: string | null = null) =>
    aiPresence.result(
      scan((s) =>
        s.ai_visibility.prompts.forEach((p, i) =>
          p.engines.forEach((e) => (e.competitors_named = i === 0 ? names : [])),
        ),
      ),
      businessName,
    );

  it("drops a single common word such as 'Coverage', and logs it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = named(["Coverage", "Alpha Plumbing"]);
    expect(r.raw.topCompetitors).toBe("Alpha Plumbing");
    expect((r.raw.prompts as { competitors: string[] }[])[0].competitors).toEqual(["Alpha Plumbing"]);
    expect(warn).toHaveBeenCalledWith("[prospecting/ai_presence] competitor names dropped", { dropped: ["Coverage"] });
    warn.mockRestore();
  });

  it("drops a single trade noun and names made only of common words; keeps a one-word brand", () => {
    const r = named(["Plumbers", "The Best", "Local Services", "24/7", "Plumbquick", "The Drain Doctor"]);
    expect((r.raw.prompts as { competitors: string[] }[])[0].competitors).toEqual(["Plumbquick", "The Drain Doctor"]);
  });

  it("keeps every multi-word name with a trade noun in it", () => {
    const names = [
      "Affordable Plumbing", "Reliable Plumbers", "Emergency Plumbers", "Best Electrical", "Trusted Electricians",
      "Local Locksmiths", "24/7 Plumbing", "Local Plumbing Services",
    ];
    expect((named(names).raw.prompts as { competitors: string[] }[])[0].competitors).toEqual(names);
  });

  it("drops the prospect's own name, ignoring case, punctuation and (Pty) Ltd", () => {
    const r = named(["fixture plumbing", "Alpha Plumbing"], "Fixture Plumbing (Pty) Ltd");
    expect(r.raw.topCompetitors).toBe("Alpha Plumbing");
  });

  it("without the prospect's name, a name that merely resembles it is kept", () => {
    expect(named(["Fixture Plumbing"]).raw.topCompetitors).toBe("Fixture Plumbing");
  });
});
