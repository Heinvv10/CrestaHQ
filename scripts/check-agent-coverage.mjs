#!/usr/bin/env node
/**
 * Agent route coverage gate (AGENCY_AGENT_API_PLAN.md, PR A1).
 *
 * Every HTTP route the app serves is something a person can do. Whether an
 * agent can do it too is a decision, and this script makes sure it is written
 * down: every `path:METHOD` of every route file under src/app (`route.ts`,
 * `.tsx`, `.js`, `.mjs`) must be accounted for in scripts/agent-coverage.json,
 * or the lint fails.
 *
 *   - `trees`  every top-level tree (`api/<segment>`, or `<segment>` outside
 *              api/) is either `{ "scope": true }` or excluded whole with
 *              `{ "exclude": { category, reason } }`. A route in a tree that
 *              is not listed fails, so a new tree is a decision too.
 *   - `routes` inside an in-scope tree, a key maps to `{ "tools": [...] }`
 *              (agent tool names; the vitest half,
 *              src/lib/api/agent-coverage.test.ts, proves each is a real,
 *              agent-callable tool) or `{ "exclude": { category, reason } }`.
 *   - `grandfathered`  exact keys that existed when the gate landed and have
 *              no tool yet. Each must also appear in FROZEN
 *              (scripts/agent-coverage-frozen.mjs), and FROZEN may hold
 *              nothing that is not grandfathered, so a route that gets a tool
 *              leaves both lists in the same PR.
 *
 * A NEW route can never be grandfathered: it is not in FROZEN, so listing it
 * there fails. FROZEN is a file anyone can edit; that it only ever shrinks is
 * enforced by review (the PR template asks), not by this script. Comparing it
 * against origin/main would pass vacuously in the deploy checkout and in a
 * buyer's generated repo, which have no such ref.
 *
 * Only GET/POST/PUT/PATCH/DELETE are keyed. HEAD and OPTIONS are preflight /
 * probe companions of a keyed method, not operations of their own. A route
 * file exporting none of the five fails, so an export form this parser does
 * not know can never make a route invisible.
 *
 * Runs as part of `pnpm lint` (so CI and scripts/deploy-velo.sh run the same
 * bytes). Zero dependencies.
 *
 * Usage: node scripts/check-agent-coverage.mjs [repo-root]
 *
 * The root defaults to this repo. Tests pass a fixture root laid out the same
 * way (src/app/, scripts/agent-coverage.json, scripts/agent-coverage-frozen.mjs).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CATEGORIES = new Set([
  "human-only",
  "chat-only",
  "internal",
  "public-unauth",
  "key-management",
  "queue-itself",
]);

const METHODS = "GET|POST|PUT|PATCH|DELETE";
const DECLARED = new RegExp(
  `^export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+(${METHODS})\\b`,
  "gm",
);
const ROUTE_FILE = /^route\.(ts|tsx|js|mjs)$/;

/** The HTTP methods a route file exports, in source order, deduplicated. */
export function methodsOf(src) {
  const found = [...src.matchAll(DECLARED)].map((m) => m[1]);
  // `export { handler as POST }` — not used today, but it must not hide a method.
  for (const block of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of block[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (new RegExp(`^(${METHODS})$`).test(name)) found.push(name);
    }
  }
  return [...new Set(found)];
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
 * @param files    [{ path: "api/x/[id]", methods: ["GET", …] }]
 * @param manifest the parsed agent-coverage.json
 * @param frozen   the FROZEN key list
 * @returns error strings; empty means the gate passes
 */
export function checkCoverage(files, manifest, frozen) {
  const errors = [];
  const trees = manifest.trees ?? {};
  const routes = manifest.routes ?? {};
  const grandfathered = manifest.grandfathered ?? [];
  const frozenSet = new Set(frozen);
  const grandSet = new Set(grandfathered);

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
  for (const file of files) {
    const tree = treeOf(file.path);
    seenTrees.add(tree);
    if (!(tree in trees)) {
      errors.push(`${file.path}: new top-level tree "${tree}" — add it to "trees" as in scope or excluded with a reason`);
      continue;
    }
    if (file.methods.length === 0) {
      errors.push(`${file.path}: route file exports no ${METHODS.replaceAll("|", "/")} handler this checker can parse`);
      continue;
    }
    if (trees[tree]?.scope !== true) continue;
    for (const method of file.methods) live.add(`${file.path}:${method}`);
  }

  for (const tree of Object.keys(trees)) {
    if (!seenTrees.has(tree)) errors.push(`tree ${tree}: no route lives under it any more — remove it`);
  }

  for (const key of live) {
    if (!(key in routes) && !grandSet.has(key)) {
      errors.push(`${key}: unlisted — map it to agent tool(s) or an exclusion in scripts/agent-coverage.json (new routes can never be grandfathered)`);
    }
  }

  for (const [key, entry] of Object.entries(routes)) {
    if (!live.has(key)) {
      errors.push(`${key}: listed in "routes" but no in-scope route serves it — remove the entry`);
      continue;
    }
    if (grandSet.has(key)) errors.push(`${key}: in both "routes" and "grandfathered"`);
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

  if (grandSet.size !== grandfathered.length) errors.push(`"grandfathered" lists a key twice`);
  for (const key of grandfathered) {
    if (/[*?{}]/.test(key)) {
      errors.push(`${key}: "grandfathered" takes exact path:METHOD keys, never a glob`);
    } else if (!live.has(key)) {
      errors.push(`${key}: grandfathered but no in-scope route serves it — remove it here and from FROZEN`);
    } else if (!frozenSet.has(key)) {
      errors.push(`${key}: grandfathered but not in FROZEN — a new route is never grandfathered; give it tool(s) or an exclusion`);
    }
  }
  for (const key of frozenSet) {
    if (!grandSet.has(key)) {
      errors.push(`${key}: in FROZEN but no longer grandfathered — delete it from scripts/agent-coverage-frozen.mjs (FROZEN only shrinks)`);
    }
  }

  return errors;
}

// Importing this module for its pure exports must not run the scan.
const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const appDir = join(root, "src", "app");
  const files = walk(appDir).map((full) => ({
    path: dirname(relative(appDir, full)).split("\\").join("/"),
    methods: methodsOf(readFileSync(full, "utf8")),
  }));
  const manifest = JSON.parse(readFileSync(join(root, "scripts", "agent-coverage.json"), "utf8"));
  const { FROZEN } = await import(pathToFileURL(join(root, "scripts", "agent-coverage-frozen.mjs")).href);
  const errors = checkCoverage(files, manifest, FROZEN);

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
  const keys = files.reduce((n, f) => n + f.methods.length, 0);
  console.log(`agent coverage check: ${files.length} route files, ${keys} path:METHOD keys accounted for`);
}
