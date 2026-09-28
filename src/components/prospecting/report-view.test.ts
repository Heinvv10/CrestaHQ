import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ReportSections } from "./report-view";
import type { PublicReportSection } from "@/lib/prospecting/public-sections";

const section = (key: PublicReportSection["key"], details: PublicReportSection["details"]): PublicReportSection => ({
  key, status: "ok", score: 50, findings: [], reason: null, reasonCode: null, details,
});

it("only URL details render as links — a competitor name that looks like a URL stays text", () => {
  const html = renderToStaticMarkup(
    createElement(ReportSections, {
      sections: [
        section("business_details", { website: "https://acme.test" }),
        section("ai_presence", { mentionedIn: 0, answersMeasured: 6, topCompetitors: "https://evil.example, Beta" }),
      ],
    }),
  );
  expect(html).toContain('href="https://acme.test"');
  expect(html).not.toContain('href="https://evil.example');
  expect(html).toContain("https://evil.example, Beta");
});

it("the connect link shows only where a not-connected section meets a connectHref", () => {
  const nc: PublicReportSection = { ...section("ai_readiness", {}), status: "unavailable", score: null, reasonCode: "not_connected", reason: "Not connected" };
  expect(renderToStaticMarkup(createElement(ReportSections, { sections: [nc] }))).not.toContain("Connect ApexGEO");
  expect(renderToStaticMarkup(createElement(ReportSections, { sections: [nc], connectHref: "/sa/x/dashboard/settings" }))).toContain(
    'href="/sa/x/dashboard/settings"',
  );
});

it("says 'No issues found.' only for a scored section — never for an unscored one (listings, AI presence left open)", () => {
  const html = (s: PublicReportSection) => renderToStaticMarkup(createElement(ReportSections, { sections: [s] }));
  expect(html({ ...section("gbp", {}), score: 100 })).toContain("No issues found.");
  expect(html({ ...section("listings", { Facebook: "found" }), score: null })).not.toContain("No issues found.");
  expect(html({ ...section("ai_presence", { mentionedIn: 0, answersMeasured: 5 }), score: null })).not.toContain(
    "No issues found.",
  );
});

it("by default lists at most three plain facts; showAll (member toggle) adds the raw metrics and hidden rows", () => {
  const perf = section("website_performance", {
    lcpSeconds: 6.2, fcpSeconds: 2.1, speedIndexSeconds: 7.4, tbtMs: 900, cls: 0.2, mobileViewport: "notMeasured",
  });
  const listings = { ...section("listings", { Facebook: "found", Bing: "not_found", Cylex: "unknown" }), score: null };
  const ads = section("ads", { metaAdLibraryUrl: "https://ads.test/meta" });
  const render = (showAll: boolean) =>
    renderToStaticMarkup(createElement(ReportSections, { sections: [perf, listings, ads], showAll }));
  const compact = render(false);
  expect(compact).toContain("Main content shown on a phone (s)");
  for (const hidden of ["Speed index (s)", "Blocking time (ms)", "Layout shift", "First content shown (s)", "Not measured", "No match", "Could not check", "https://ads.test/meta"]) {
    expect(compact).not.toContain(hidden);
  }
  const all = render(true);
  for (const shown of ["Speed index (s)", "Blocking time (ms)", "Layout shift", "Not measured", "No match", "Could not check", "https://ads.test/meta"]) {
    expect(all).toContain(shown);
  }
  const many = section("lead_capture", { whatsapp: true, booking: true, contactForm: true, phoneLink: true, chatWidget: true });
  const html = renderToStaticMarkup(createElement(ReportSections, { sections: [many] }));
  expect(html.match(/<dt/g)).toHaveLength(3);
});

it("orders rows worst score first, unscored and unmeasured after", () => {
  const html = renderToStaticMarkup(
    createElement(ReportSections, {
      sections: [
        { ...section("gbp", {}), score: 100 },
        { ...section("listings", {}), score: null },
        { ...section("reputation", {}), score: 20 },
        { ...section("tech_stack", {}), score: 60 },
      ],
    }),
  );
  const order = [...html.matchAll(/report-section-([a-z_]+)/g)].map((m) => m[1]);
  expect(order).toEqual(["reputation", "tech_stack", "gbp", "listings"]);
});

it("hideEmpty drops a section with no score, no findings and no rows — the member view (no hideEmpty) still shows it", () => {
  const emptyListings = { ...section("listings", {}), score: null };
  const scoredGbp = { ...section("gbp", {}), score: 100 };
  const withFindings: PublicReportSection = {
    ...section("reputation", {}),
    score: null,
    findings: [{ code: "low_rating", text: "finding", impact: null, cta: null }],
  };
  const render = (hideEmpty: boolean) =>
    renderToStaticMarkup(
      createElement(ReportSections, { sections: [emptyListings, scoredGbp, withFindings], hideEmpty }),
    );
  const member = render(false);
  expect(member).toContain("report-section-listings");
  const publicHtml = render(true);
  expect(publicHtml).not.toContain("report-section-listings");
  expect(publicHtml).toContain("report-section-gbp");
  expect(publicHtml).toContain("report-section-reputation");
});

it("hideEmpty keeps an unscored section that still has rows to show (listings with a found match)", () => {
  const withRows = { ...section("listings", { Facebook: "found" }), score: null };
  const html = renderToStaticMarkup(createElement(ReportSections, { sections: [withRows], hideEmpty: true }));
  expect(html).toContain("report-section-listings");
});

it("hideEmpty never drops a failed/timed-out/unavailable section — the reason still matters", () => {
  const timedOut: PublicReportSection = {
    ...section("listings", {}),
    status: "timeout",
    score: null,
    reason: "The directories did not answer in time.",
  };
  const html = renderToStaticMarkup(createElement(ReportSections, { sections: [timedOut], hideEmpty: true }));
  expect(html).toContain("report-section-listings");
  expect(html).toContain("The directories did not answer in time.");
});

it("AI presence: questions show for a non-ok section too, and the counts never render twice with showAll", () => {
  const pending: PublicReportSection = {
    ...section("ai_presence", { question1: "best plumber in Exampletown" }), status: "timeout", score: null, reason: "Timed out.",
  };
  expect(renderToStaticMarkup(createElement(ReportSections, { sections: [pending] }))).toContain("best plumber in Exampletown");
  const ok = section("ai_presence", { mentionedIn: 2, answersMeasured: 6, topCompetitors: "Alpha", models: "m1", question1: "q" });
  const all = renderToStaticMarkup(createElement(ReportSections, { sections: [ok], showAll: true }));
  expect(all.match(/Alpha/g)).toHaveLength(1);
  expect(all).not.toContain("AI answers checked");
  expect(all).not.toContain("AI answers naming the business");
  expect(all).toContain("AI models asked");
});
