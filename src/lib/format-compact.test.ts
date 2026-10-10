import { expect, it } from "vitest";
import { formatCurrencyCompact } from "@/lib/format";

const N = " ";
it.each([
  ["ZAR", 0, `ZAR${N}0`], ["ZAR", 5, `ZAR${N}5`], ["ZAR", 250, `ZAR${N}250`],
  ["ZAR", 999, `ZAR${N}999`], ["ZAR", 1000, `ZAR${N}1K`], ["ZAR", 1500, `ZAR${N}1.5K`],
  ["ZAR", 617283, `ZAR${N}617.3K`], ["ZAR", 1e9, `ZAR${N}1B`], ["ZAR", -1500, `-ZAR${N}1.5K`],
  ["USD", 0, "$0"], ["USD", 5, "$5"], ["USD", 250, "$250"], ["USD", 999, "$999"],
  ["USD", 1000, "$1K"], ["USD", 1500, "$1.5K"], ["USD", 617283, "$617.3K"], ["USD", 1e9, "$1B"], ["USD", -1500, "-$1.5K"],
  ["EUR", 0, "€0"], ["EUR", 5, "€5"], ["EUR", 250, "€250"], ["EUR", 999, "€999"],
  ["EUR", 1000, "€1K"], ["EUR", 1500, "€1.5K"], ["EUR", 617283, "€617.3K"], ["EUR", 1e9, "€1B"], ["EUR", -1500, "-€1.5K"],
  ["USD", Number.NaN, "$0"], ["USD", Infinity, "$0"],
  ["XX", 1500, "XX 1,500"], ["XX", Number.NaN, "XX 0"],
])("%s %s -> %s", (cur, v, out) => {
  expect(formatCurrencyCompact(v as number, cur as string)).toBe(out);
});
