import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AreaChart } from "@/components/reports/charts";
import { formatCurrency } from "@/lib/format";

const data = [
  { x: "Mon", y: 0 },
  { x: "Tue", y: 1000 },
  { x: "Wed", y: 2500 },
];

it("labels the y-axis 0, midpoint and max through formatValue", () => {
  const html = renderToStaticMarkup(
    createElement(AreaChart, { data, formatValue: (v: number) => formatCurrency(v, "ZAR") }),
  );
  const labels = [...html.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  expect(labels).toEqual([0, 1250, 2500].map((v) => formatCurrency(v, "ZAR")));
  expect(labels[2]).toContain("ZAR");
});

it("puts a formatted tooltip title on every point", () => {
  const html = renderToStaticMarkup(
    createElement(AreaChart, { data, formatValue: (v: number) => formatCurrency(v, "ZAR") }),
  );
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  expect(titles).toEqual(data.map((d) => `${d.x}: ${formatCurrency(d.y, "ZAR")}`));
});

it("defaults to rounded locale numbers and keeps axis text on theme tokens", () => {
  const html = renderToStaticMarkup(createElement(AreaChart, { data }));
  expect(html).toContain("Tue: 1,000");
  expect(html).toContain("fill-muted-foreground");
  expect(html).not.toMatch(/(fill|stroke)="(white|#[0-9a-fA-F]{3,6})/i);
});
