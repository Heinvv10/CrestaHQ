import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// SpamAssassin's X_HTML_HIDDEN_COLOR penalises HTML mail whose text colour is
// pure white. Server-rendered HTML must use #fefefe instead. The `[^-a-z]`
// prefix excludes `background-color` / `border-color`; backgrounds may stay white.
const PURE_WHITE_TEXT =
  /(^|[^-a-z])color\s*:\s*(#fff(?:fff)?(?![0-9a-f])|white(?![a-z0-9])|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*1(?:\.0+)?\s*)?\)|hsla?\(\s*0\s*,\s*0%\s*,\s*100%\s*(?:,\s*1(?:\.0+)?\s*)?\))/i;

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ROOTS = ["src/lib", "src/app/api"];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

it.each([
  "color:#fff",
  "color: #FFFFFF",
  "color : white",
  "color:rgb(255,255,255)",
  "color:rgba(255, 255, 255, 1)",
  "color:hsl(0,0%,100%)",
])("regex matches %s", (s) => {
  expect(PURE_WHITE_TEXT.test(s)).toBe(true);
});

it.each([
  "background-color:#fff",
  "border-color:#fff",
  "color:#fffff0",
  "color:#ffffffcc",
  "color:whitesmoke",
  "color:#fefefe",
])("regex ignores %s", (s) => {
  expect(PURE_WHITE_TEXT.test(s)).toBe(false);
});

it("no server-rendered HTML uses a pure-white text colour", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(REPO_ROOT, root))) {
      scanned++;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (PURE_WHITE_TEXT.test(line)) offenders.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
        });
    }
  }
  expect(scanned).toBeGreaterThan(100);
  expect(offenders).toEqual([]);
});
