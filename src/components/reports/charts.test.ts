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

const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AreaChart, props as never));
const axis = (html: string) =>
  [...html.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), t: m[2] }));

it("shows only '0' for empty, all-zero and single-zero series", () => {
  for (const d of [[], [{ x: "a", y: 0 }, { x: "b", y: 0 }], [{ x: "a", y: 0 }]]) {
    expect(axis(render({ data: d })).map((l) => l.t)).toEqual(["0"]);
  }
});

it("never prints duplicate axis labels for fractional data (max < 1)", () => {
  const labels = axis(render({ data: [{ x: "a", y: 0.3 }, { x: "b", y: 0.6 }] })).map((l) => l.t);
  expect(labels).toEqual(["0", "0.3", "0.6"]);
  expect(new Set(labels).size).toBe(labels.length);
});

it("keeps a 9-digit currency axis label inside the viewBox", () => {
  const html = render({
    data: [{ x: "a", y: 0 }, { x: "b", y: 617_283_000 }],
    formatAxis: (v: number) => formatCurrency(v, "ZAR"),
  });
  const labels = axis(html);
  const widest = labels.reduce((m, l) => Math.max(m, l.t.length), 0);
  for (const l of labels) expect(l.x - l.t.length * 5.5).toBeGreaterThanOrEqual(0);
  expect(widest).toBeGreaterThan(8);
});

it("treats NaN / Infinity as 0 and never prints NaN", () => {
  const html = render({ data: [{ x: "a", y: Number.NaN }, { x: "b", y: 5 }, { x: "c", y: Infinity }] });
  expect(html).not.toMatch(/NaN|Infinity/);
});

it("exposes the chart as an image with a label", () => {
  expect(render({ data })).toMatch(/<svg[^>]*role="img"[^>]*aria-label="Trend chart, 3 points/);
});

it("drops a midpoint label that formats the same as a neighbour", () => {
  const labels = axis(render({ data: [{ x: "a", y: 0 }, { x: "b", y: 1 }], formatValue: (v: number) => String(Math.round(v)) })).map((l) => l.t);
  expect(labels).toEqual(["0", "1"]);
});

it.each([
  [[1, 0, 1], ["0", "1"]],
  [[3, 0, 2], ["0", "2", "3"]],
  [[5, 1], ["0", "3", "5"]],
  [[0.4, 0.8], ["0", "0.4", "0.8"]],
])("count series %j shows integer-only axis, fractions only for fractional data", (ys, want) => {
  const d = (ys as number[]).map((y, i) => ({ x: String(i), y }));
  expect(axis(render({ data: d })).map((l) => l.t)).toEqual(want);
});

it("draws the midpoint label at the y of the value it shows ([5,1] -> tick 3)", () => {
  const h = 140;
  const html = render({ data: [{ x: "a", y: 5 }, { x: "b", y: 1 }], height: h });
  const m = [...html.matchAll(/<text x="[\d.]+" y="([\d.]+)"[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map((x) => ({ y: Number(x[1]), t: x[2] }));
  const mid = m.find((l) => l.t === "3")!;
  // text y is baseline + 3; plot y for value 3 on a 0..5 axis
  expect(mid.y - 3).toBeCloseTo(h - 18 - (3 / 5) * (h - 36), 5);
});
