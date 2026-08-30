#!/usr/bin/env node
/**
 * Tenancy-guard regression check for the AI Suite capability registry.
 *
 * The security of src/lib/ai-suite/capabilities.ts rests on a CONVENTION:
 * every capability's `execute` must anchor everything it reads or writes to
 * the authenticated caller's tenant —
 *
 *   - sub-account level: queries/paths scoped with `ctx.subAccountId`, and any
 *     model-supplied document id re-anchored (`doc.subAccountId !== ctx.subAccountId`
 *     → refuse). Self-scoped lookups may instead key off the caller's own
 *     membership index (`userMemberships/${ctx.uid}`).
 *   - agency level: scoped/re-anchored with `ctx.agencyId`.
 *
 * Nothing in the type system enforces that convention, so this script does:
 * it parses the registry source and FAILS THE LINT when a capability block
 * has no visible tenant anchor. It is a lint-style source inspection — it
 * proves the guard is *present*, not that it is *correct* — its job is to
 * catch the realistic failure mode: a future capability added without any
 * tenancy scoping at all.
 *
 * Runs as part of `pnpm lint` (see package.json). Zero dependencies.
 *
 * Usage: node scripts/check-capability-tenancy.mjs [path-to-capabilities.ts]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(
  __dirname,
  "..",
  "src",
  "lib",
  "ai-suite",
  "capabilities.ts",
);
const filePath = process.argv[2] ?? DEFAULT_PATH;

/**
 * Capabilities allowed to touch NO tenant data at all. Every entry must have
 * a written justification, and the block is additionally required to contain
 * no Firestore access (`getAdminDb(`) so the exemption can't quietly grow
 * into a data path.
 */
const EXTERNAL_ONLY = new Map([
  [
    "research_website_reference",
    "Fetches a public external URL via Firecrawl; reads no Firestore data.",
  ],
]);

/**
 * If parsing ever finds fewer literal capabilities than this, the file's
 * shape has changed and the checker is probably no longer seeing them —
 * fail loudly instead of passing vacuously.
 */
const MIN_EXPECTED_CAPABILITIES = 25;

const src = readFileSync(filePath, "utf8");

// ── Split the registry into capability blocks ────────────────────────────
// Literal entries all declare `    name: "<snake_case>",` at 4-space indent.
// (Parameter properties like `name: { type: "string" }` don't match — they
// have no quoted string value. The generated `_in_sub_account` wrapper uses
// a template literal, so it's excluded; its re-anchor is asserted separately.)
const nameRe = /^ {4}name: "([a-z0-9_]+)",$/gm;
const matches = [...src.matchAll(nameRe)];

const failures = [];
const checked = [];

for (let i = 0; i < matches.length; i++) {
  const name = matches[i][1];
  const start = matches[i].index;
  const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
  const block = src.slice(start, end);

  const levelMatch = block.match(/^ {4}level: "(agency|sub-account)",$/m);
  if (!levelMatch) {
    // A `name:` line that isn't a capability entry (defensive) — but if it
    // also declares requiredRole it IS one and the level is malformed.
    if (/^ {4}requiredRole:/m.test(block)) {
      failures.push(
        `${name}: has requiredRole but no parseable \`level\` — capability shape changed; update this checker.`,
      );
    }
    continue;
  }
  const level = levelMatch[1];
  checked.push({ name, level });

  if (EXTERNAL_ONLY.has(name)) {
    if (block.includes("getAdminDb(")) {
      failures.push(
        `${name}: is allowlisted as external-only (${EXTERNAL_ONLY.get(name)}) but now touches Firestore (getAdminDb). Remove it from the allowlist and anchor its reads to the caller's tenant.`,
      );
    }
    continue;
  }

  if (level === "agency") {
    if (!block.includes("ctx.agencyId")) {
      failures.push(
        `${name} (agency): execute has no visible \`ctx.agencyId\` anchor. Every agency capability must scope its queries to the caller's agency or re-anchor model-supplied ids (doc.agencyId !== ctx.agencyId → refuse).`,
      );
    }
    continue;
  }

  // sub-account level
  const anchored =
    block.includes("ctx.subAccountId") ||
    // Self-scoped lookups keyed to the caller's own membership index.
    block.includes("userMemberships/${ctx.uid}");
  if (!anchored) {
    failures.push(
      `${name} (sub-account): execute has no visible tenant anchor. Scope every query/path with \`ctx.subAccountId\`, re-anchor any model-supplied document id (doc.subAccountId !== ctx.subAccountId → refuse), or — for a capability that reads no tenant data at all — add a justified EXTERNAL_ONLY entry in scripts/check-capability-tenancy.mjs.`,
    );
  }
}

// ── Sanity: the parser must still be seeing the registry ─────────────────
if (checked.length < MIN_EXPECTED_CAPABILITIES) {
  failures.push(
    `Only ${checked.length} capabilities parsed (expected ≥ ${MIN_EXPECTED_CAPABILITIES}). The registry's source shape probably changed — update the parsing in this checker rather than letting it pass vacuously.`,
  );
}

// ── The generated agency wrapper must re-anchor the target sub-account ───
// inSubAccount() produces the `*_in_sub_account` variants at runtime; its
// execute must verify the model-supplied sub-account belongs to the caller's
// agency before delegating.
const wrapperStart = src.indexOf("function inSubAccount(");
if (wrapperStart === -1) {
  failures.push(
    "inSubAccount() wrapper not found — if the agency delegation mechanism was renamed/removed, update this checker.",
  );
} else {
  const wrapper = src.slice(wrapperStart, wrapperStart + 6000);
  // Two anchors, BOTH required: (1) the direct-id path compares the loaded
  // doc's agencyId to the caller's (either polarity), and (2) the
  // name/number-fallback resolution queries WITHIN the caller's agency only.
  if (!/agencyId (?:!==|===) ctx\.agencyId/.test(wrapper)) {
    failures.push(
      "inSubAccount() wrapper: the direct-id agency re-anchor (`snap.data()?.agencyId ===/!== ctx.agencyId`) is missing — delegated capabilities could run against another tenant's sub-account.",
    );
  }
  if (!/where\("agencyId", "==", ctx\.agencyId\)/.test(wrapper)) {
    failures.push(
      'inSubAccount() wrapper: the fallback resolution must stay scoped `where("agencyId", "==", ctx.agencyId)` — resolving a name across agencies would break tenant containment.',
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────
const agencyCount = checked.filter((c) => c.level === "agency").length;
const subCount = checked.filter((c) => c.level === "sub-account").length;

if (failures.length > 0) {
  console.error("✖ AI Suite tenancy check FAILED:\n");
  for (const f of failures) console.error(`  • ${f}\n`);
  console.error(
    `Checked ${checked.length} capabilities (${agencyCount} agency, ${subCount} sub-account) in ${filePath}`,
  );
  process.exit(1);
}

console.log(
  `✓ AI Suite tenancy check passed — ${checked.length} capabilities (${agencyCount} agency, ${subCount} sub-account) all carry a tenant anchor; ${EXTERNAL_ONLY.size} justified external-only exemption(s); delegation wrapper re-anchors.`,
);
