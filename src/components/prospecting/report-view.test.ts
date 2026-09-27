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
        section("ai_presence", { topCompetitors: "https://evil.example, Beta" }),
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
