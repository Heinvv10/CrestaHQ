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
 * Methods are read from the source with comments stripped: `export` (leading
 * whitespace allowed) `async function | function | const | let | var` NAME,
 * `export const|let|var { … } =`, and `export { x as NAME }` (quoted names
 * too). Then every GET/HEAD/OPTIONS/POST/PUT/PATCH/DELETE token left in the
 * file, strings included, must be one of the parsed methods; any other is an
 * export form this parser does not know, and the file fails rather than
 * hiding a route. `export *` is refused outright. Only GET/POST/PUT/PATCH/
 * DELETE are keyed; HEAD and OPTIONS are probe / preflight companions. These
 * per-file checks run in in-scope trees only: in an excluded tree no method
 * is keyed, so there is nothing for a parse miss to hide.
 *
 * Runs as part of `pnpm lint` (so CI and scripts/deploy-velo.sh run the same
 * bytes). Zero dependencies.
 *
 * Usage: node scripts/check-agent-coverage.mjs [repo-root]
 *
 * The root defaults to this repo. Tests pass a fixture root laid out the same
 * way (src/app/, scripts/agent-coverage.json, scripts/agent-coverage-frozen.json).
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = new Set([
  "human-only",
  "chat-only",
  "internal",
  "public-unauth",
  "key-management",
  "queue-itself",
]);

const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
const KEYED = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const NAMES = ALL_METHODS.join("|");
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx)$/;
const has = (obj, key) => Object.hasOwn(obj, key);

/** Blank comments (keeping newlines), leave strings and template literals intact. */
export function stripComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/**
 * Parse a route file. `methods` are the parsed exports (all seven names);
 * `stray` are method tokens in the file no parsed export accounts for;
 * `exportStar` is true when the file has `export *`.
 */
export function parseRoute(src) {
  const clean = stripComments(src);
  const found = new Set();
  const declared = new RegExp(
    `^\\s*export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+(${NAMES})\\b`,
    "gm",
  );
  for (const m of clean.matchAll(declared)) found.add(m[1]);
  // The name a list entry binds: `x as NAME`, `x as "NAME"`, `key: NAME`, `NAME = default`.
  const bound = (part) =>
    part.split(/\s+as\s+|:/).pop().split("=")[0].trim().replace(/^\.\.\.|^["']|["']$/g, "");
  const braces = [
    ...clean.matchAll(/^\s*export\s*\{([^}]*)\}/gm),
    ...clean.matchAll(/^\s*export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/gm),
  ];
  for (const block of braces) {
    for (const part of block[1].split(",")) {
      const name = bound(part);
      if (ALL_METHODS.includes(name)) found.add(name);
    }
  }
  const tokens = new Set([...clean.matchAll(new RegExp(`\\b(${NAMES})\\b`, "g"))].map((m) => m[1]));
  return {
    methods: ALL_METHODS.filter((m) => found.has(m)),
    stray: ALL_METHODS.filter((m) => tokens.has(m) && !found.has(m)),
    exportStar: /^\s*export\s*\*/m.test(clean),
  };
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
    if (parsed.exportStar) {
      errors.push(`${path}: \`export *\` in a route file — export methods by name`);
      continue;
    }
    if (parsed.stray.length > 0) {
      errors.push(`${path}: ${parsed.stray.join("/")} appears in the file but no export this checker parses declares it — export methods by name`);
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
    parsed: parseRoute(readFileSync(full, "utf8")),
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
