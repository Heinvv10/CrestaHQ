import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Serverless hosts freeze the function once the route returns, so background
 * work in server code goes through runAfterResponse (after-response.ts), not a
 * bare `void someCall(...)` / `void (async () => ...)()`, which is cut off
 * mid-flight. This scans server source for those statements. A new one fails
 * here: convert it, or add it below with the reason it must stay bare.
 */

const ROOT = join(__dirname, "..", "..", "..");
const SCAN = ["src/app", "src/lib", "src/middleware.ts"];

/** [file, start of the statement, why it stays a bare void]. */
const ALLOWED: Array<[string, string, string]> = [
  ["src/lib/server/after-response.ts", "void run();", "the helper's own no-request-scope fallback"],
  ["src/lib/google-calendar/push.ts", "void pushBookingToGoogle(eventId);", "existing after() helper's no-request-scope fallback"],
  ["src/lib/reputation/sentiment-after.ts", "void work().catch(", "existing after() helper's no-request-scope fallback"],
  ["src/lib/prospecting/mystery-shop/form/container.ts", "void remove(name);", "docker form runner: needs a long-lived host, never serverless"],
  ["src/lib/prospecting/mystery-shop/form/container.ts", "void chain.then(", "docker form runner: stdout line plumbing inside its own promise"],
  ["src/lib/audio/notification-sounds.ts", "void ctx.resume().catch(", "browser-only module (AudioContext); never runs on the server"],
];

// A `void` statement that voids a call, an async IIFE, or a chain continued
// on the next line, wherever a statement can begin: line start, after `;`,
// `{`, `}`, `)` (an `if (...)` / `for (...)` body) or `else`. `void x;` (an
// unused-value marker) and an arrow body `=> void x` are not statements of
// this shape.
const BARE_VOID = /(^|[;{})]|\belse)\s*void\s+(\(\s*async\b|[A-Za-z_$][\w$.]*\s*(\(|$))/;

function serverFiles(): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
      return;
    }
    const rel = relative(ROOT, p);
    if (!/\.tsx?$/.test(rel) || /\.(test|spec)\.tsx?$/.test(rel)) return;
    if (/(^|\/)hooks\//.test(rel) || /(^|\/)use-[^/]*$/.test(rel)) return;
    if (/^\s*["']use client["']/.test(readFileSync(p, "utf8").slice(0, 300))) return;
    out.push(rel);
  };
  for (const s of SCAN) walk(join(ROOT, s));
  return out;
}

function bareVoids(rel: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  readFileSync(join(ROOT, rel), "utf8")
    .split("\n")
    .forEach((raw, i) => {
      const t = raw.trim();
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        return;
      }
      if (t.startsWith("/*")) {
        inBlock = !t.includes("*/");
        return;
      }
      if (t.startsWith("//") || t.startsWith("*")) return;
      if (BARE_VOID.test(t)) hits.push({ line: i + 1, text: t });
    });
  return hits;
}

const isAllowed = (rel: string, text: string) =>
  ALLOWED.some(([f, start]) => f === rel && text.includes(start));

describe("BARE_VOID", () => {
  it.each([
    ["own line", "void f();"],
    ["own line, async IIFE", "void (async () => { await g(); })();"],
    ["chain continued on the next line", "void ref"],
    ["if body", "if (c) void f();"],
    ["for body", "for (const x of xs) void f(x);"],
    ["block", "{ void f(); }"],
    ["function body", "export function _m() { void Promise.resolve(1); }"],
    ["after a statement", "a(); void f();"],
    ["else", "} else void f();"],
  ])("catches a bare void: %s", (_shape, line) => {
    expect(BARE_VOID.test(line)).toBe(true);
  });

  it.each([
    ["arrow body", "const g = () => void f();"],
    ["arrow body after params", "update: (r, d) => void writes.push([r, d]),"],
    ["unused-value marker", "void fired;"],
    ["void return type", "function h(): void {"],
    ["callback type", "onClose: (cb: () => void) => void;"],
  ])("leaves alone: %s", (_shape, line) => {
    expect(BARE_VOID.test(line)).toBe(false);
  });
});

describe("no bare fire-and-forget in server code", () => {
  const files = serverFiles();

  it("scans the server tree", () => {
    // An empty scan would pass vacuously.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("src/app/api/forms/[id]/submit/route.ts");
  });

  it("finds no bare void call outside the allow-list", () => {
    const offenders = files.flatMap((rel) =>
      bareVoids(rel)
        .filter((h) => !isAllowed(rel, h.text))
        .map((h) => `${rel}:${h.line}  ${h.text}`),
    );
    expect(offenders, "use runAfterResponse(() => ...) instead").toEqual([]);
  });

  it("has no stale allow-list entries", () => {
    const stale = ALLOWED.filter(
      ([f, start]) => !files.includes(f) || !bareVoids(f).some((h) => h.text.includes(start)),
    ).map(([f, start]) => `${f}  ${start}`);
    expect(stale).toEqual([]);
  });
});
