#!/usr/bin/env node
/**
 * Agent route coverage gate (AGENCY_AGENT_API_PLAN.md, PR A1).
 *
 * Every HTTP route the app serves is something a person can do. Whether an
 * agent can do it too is a decision, and this script makes sure it is written
 * down: every `path:METHOD` of every route file Next serves under src/app
 * (`route.ts`, `.tsx`, `.js`, `.jsx`: the default `pageExtensions`, which
 * next.config.ts does not override) must be accounted for, or the lint fails.
 *
 *   scripts/agent-coverage.json
 *     `trees`   every top-level tree (`api/<segment>`, or `<segment>` outside
 *               api/) is either `{ "scope": true }` or excluded whole with
 *               `{ "exclude": { category, reason } }`. A route in a tree that
 *               is not listed fails, so a new tree is a decision too.
 *     `routes`  inside an in-scope tree, a key maps to `{ "tools": [...] }`
 *               (src/lib/api/agent-coverage.test.ts proves each name is a
 *               real, agent-callable tool of the right read/write kind) or
 *               `{ "exclude": { category, reason } }`.
 *   scripts/agent-coverage-frozen.json
 *     FROZEN: exact keys that existed when the gate landed and have no tool
 *     yet. A key is in `routes` or in FROZEN, never both.
 *
 * What this script does NOT enforce: that FROZEN never grows. It cannot: it
 * has nothing to compare against in the deploy checkout or a buyer's repo.
 * scripts/check-agent-coverage-shrink.mjs does that in PR CI only.
 *
 * Methods are the file's exported names, read with the TypeScript compiler
 * (`typescript` is a devDependency, installed before `pnpm lint` everywhere it
 * runs): exported function / class / variable declarations, destructured
 * bindings included, and `export { … }` specifiers, quoted names and
 * re-exports included. Names are cooked, so escapes resolve. A file whose
 * exports cannot be fully known fails: a syntax error, `export *`,
 * `export default` / `export =`, or CommonJS `exports`. Only GET/POST/PUT/
 * PATCH/DELETE are keyed; HEAD and OPTIONS are probe / preflight companions.
 * These per-file checks run in in-scope trees only: in an excluded tree no
 * method is keyed, so there is nothing for a parse miss to hide.
 *
 * Runs as part of `pnpm lint` (so CI and scripts/deploy-velo.sh run the same
 * bytes). Its one dependency is `typescript`.
 *
 * Usage: node scripts/check-agent-coverage.mjs [repo-root]
 *
 * The root defaults to this repo. Tests pass a fixture root laid out the same
 * way (src/app/, scripts/agent-coverage.json, scripts/agent-coverage-frozen.json).
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const CATEGORIES = new Set([
  "human-only",
  "chat-only",
  "internal",
  "public-unauth",
  "key-management",
  "queue-itself",
]);

const ALL_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const KEYED = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;
const has = (obj, key) => Object.hasOwn(obj, key);
const isExported = (node) =>
  (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

/** Every name a binding introduces: `POST`, `{ a: POST }`, `[POST]`, nested. */
function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

/**
 * Parse a route file with the TypeScript compiler. `methods` are the exported
 * names that are HTTP methods (`.text` is cooked, so `DELETE` is DELETE);
 * `problems` are reasons the file's exports cannot be fully known, each of
 * which fails the file: a syntax error, `export *`, `export default` /
 * `export =`, or CommonJS `exports`.
 */
export function parseRoute(src, fileName = "route.ts") {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const problems = [];
  // Internal but long-stable; if a TypeScript upgrade ever drops it, fail
  // loudly rather than treat every file as clean.
  if (!Array.isArray(sf.parseDiagnostics)) throw new Error("typescript: SourceFile.parseDiagnostics is gone");
  if (sf.parseDiagnostics.length > 0) problems.push("does not parse — fix the syntax error");

  const names = [];
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) problems.push("`export *` in a route file — export methods by name");
      else for (const spec of stmt.exportClause.elements) names.push(spec.name.text);
    } else if (ts.isExportAssignment(stmt)) {
      problems.push("`export default` / `export =` in a route file — export methods by name");
    } else if (isExported(stmt)) {
      if ((ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        problems.push("`export default` in a route file — export methods by name");
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) names.push(...bindingNames(decl.name));
      } else if (stmt.name) {
        names.push(stmt.name.text);
      }
    }
  }
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === "exports") problems.push("CommonJS `exports` in a route file — export methods by name");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { methods: [...new Set(names.filter((n) => ALL_METHODS.has(n)))], problems: [...new Set(problems)] };
}

/** `api/sub-accounts/[id]/x` → `api/sub-accounts`; `pay/link/[token]` → `pay`. */
export function treeOf(routePath) {
  const parts = routePath.split("/");
  return parts[0] === "api" ? parts.slice(0, 2).join("/") : parts[0];
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (ROUTE_FILE.test(entry)) out.push(full);
  }
  return out;
}

function exclusionProblem(where, exclude) {
  if (!exclude || typeof exclude !== "object") return `${where}: exclude must be { category, reason }`;
  if (!CATEGORIES.has(exclude.category)) {
    return `${where}: exclude.category must be one of ${[...CATEGORIES].join(", ")} (got ${JSON.stringify(exclude.category)})`;
  }
  if (typeof exclude.reason !== "string" || exclude.reason.trim() === "") {
    return `${where}: exclude needs a written reason`;
  }
  return null;
}

/**
 * The whole decision, pure.
 * @param files    [{ path: "api/x/[id]", parsed: parseRoute(src) }]
 * @param manifest the parsed agent-coverage.json
 * @param frozen   the parsed agent-coverage-frozen.json (a list of keys)
 * @returns error strings; empty means the gate passes
 */
export function checkCoverage(files, manifest, frozen) {
  const errors = [];
  const trees = manifest.trees ?? {};
  const routes = manifest.routes ?? {};

  for (const [tree, entry] of Object.entries(trees)) {
    const scoped = entry?.scope === true;
    const excluded = entry?.exclude !== undefined;
    if (scoped === excluded) {
      errors.push(`tree ${tree}: must be exactly one of { "scope": true } or { "exclude": … }`);
    } else if (excluded) {
      const problem = exclusionProblem(`tree ${tree}`, entry.exclude);
      if (problem) errors.push(problem);
    }
  }

  const live = new Set();
  const seenTrees = new Set();
  for (const { path, parsed } of files) {
    const tree = treeOf(path);
    seenTrees.add(tree);
    if (!has(trees, tree)) {
      errors.push(`${path}: new top-level tree "${tree}" — add it to "trees" as in scope or excluded with a reason`);
      continue;
    }
    if (trees[tree]?.scope !== true) continue;
    if (parsed.problems.length > 0) {
      for (const problem of parsed.problems) errors.push(`${path}: ${problem}`);
      continue;
    }
    const keyed = parsed.methods.filter((m) => KEYED.has(m));
    if (keyed.length === 0) {
      errors.push(`${path}: route file exports no GET/POST/PUT/PATCH/DELETE handler this checker can parse`);
      continue;
    }
    for (const method of keyed) live.add(`${path}:${method}`);
  }

  for (const tree of Object.keys(trees)) {
    if (!seenTrees.has(tree)) errors.push(`tree ${tree}: no route lives under it any more — remove it`);
  }

  if (!Array.isArray(frozen)) {
    errors.push("scripts/agent-coverage-frozen.json must be a JSON array of path:METHOD keys");
    return errors;
  }
  const frozenSet = new Set(frozen);
  if (frozenSet.size !== frozen.length) errors.push("FROZEN lists a key twice");

  for (const key of live) {
    if (!has(routes, key) && !frozenSet.has(key)) {
      errors.push(`${key}: unlisted — map it to agent tool(s) or an exclusion in scripts/agent-coverage.json (FROZEN never grows)`);
    }
  }

  for (const [key, entry] of Object.entries(routes)) {
    if (!live.has(key)) {
      errors.push(`${key}: listed in "routes" but no in-scope route serves it — remove the entry`);
      continue;
    }
    if (frozenSet.has(key)) errors.push(`${key}: in both "routes" and FROZEN`);
    const hasTools = entry?.tools !== undefined;
    const hasExclude = entry?.exclude !== undefined;
    if (hasTools === hasExclude) {
      errors.push(`${key}: must be exactly one of { "tools": […] } or { "exclude": … }`);
    } else if (hasTools) {
      const ok =
        Array.isArray(entry.tools) &&
        entry.tools.length > 0 &&
        entry.tools.every((t) => typeof t === "string" && t.trim() !== "");
      if (!ok) errors.push(`${key}: "tools" must be a non-empty list of tool names`);
    } else {
      const problem = exclusionProblem(key, entry.exclude);
      if (problem) errors.push(problem);
    }
  }

  for (const key of frozenSet) {
    if (typeof key !== "string" || /[*?{}]/.test(key)) {
      errors.push(`${key}: FROZEN takes exact path:METHOD keys, never a glob`);
    } else if (!live.has(key)) {
      errors.push(`${key}: in FROZEN but no in-scope route serves it — remove it (FROZEN only shrinks)`);
    }
  }

  return errors;
}

// Importing this module for its pure exports must not run the scan. Compare
// real paths: a symlinked checkout or script path must still run it.
const isEntrypoint =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const appDir = join(root, "src", "app");
  const files = walk(appDir).map((full) => ({
    path: dirname(relative(appDir, full)).split("\\").join("/"),
    parsed: parseRoute(readFileSync(full, "utf8"), full),
  }));
  const read = (name) => JSON.parse(readFileSync(join(root, "scripts", name), "utf8"));
  const errors = checkCoverage(files, read("agent-coverage.json"), read("agent-coverage-frozen.json"));

  if (errors.length > 0) {
    console.error("\nAgent route coverage: every route must say whether an agent can reach it.\n");
    for (const e of errors) console.error("  " + e);
    console.error(
      "\nSee the coverage-manifest section of AGENCY_AGENT_API_PLAN.md. Categories: " +
        [...CATEGORIES].join(", ") +
        ".\n",
    );
    process.exit(1);
  }
  console.log(`agent coverage check: ${files.length} route files accounted for`);
}
