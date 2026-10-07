import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// SpamAssassin's X_HTML_HIDDEN_COLOR penalises HTML mail whose text colour is
// pure white. Server-rendered HTML must use #fefefe instead. The `[^-a-z]`
// prefix excludes `background-color`; backgrounds may stay white.
const PURE_WHITE_TEXT =
  /(^|[^-a-z])color:\s*(#fff(fff)?|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))([^0-9a-f]|$)/i;

const ROOTS = ["src/lib", "src/app/api"];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

it("no server-rendered HTML uses a pure-white text colour", () => {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(process.cwd(), root))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (PURE_WHITE_TEXT.test(line)) offenders.push(`${file.slice(process.cwd().length + 1)}:${i + 1}`);
        });
    }
  }
  expect(offenders).toEqual([]);
});
