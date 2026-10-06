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
 * Usage: node scripts/check-capability-tenancy.mjs [--names <file>] [file-or-directory ...]
 *
 * Each argument is a .ts file or a directory (every non-test .ts directly
 * inside it). The default is the registry index `capabilities.ts` plus the
 * per-resource files in `capabilities/`.
 *
 * Every registered capability must be one it checked: the registered names
 * are read from the names lock table (`--names`, default
 * src/lib/ai-suite/capability-names.test.ts, which a test keeps equal to the
 * runtime registry), and a name it did not find fails the check. A layout
 * change can therefore never shrink what it checks without failing.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AI_SUITE_DIR = join(__dirname, "..", "src", "lib", "ai-suite");
const DEFAULT_PATHS = [
  join(AI_SUITE_DIR, "capabilities.ts"),
  join(AI_SUITE_DIR, "capabilities"),
];
const args = process.argv.slice(2);
const namesAt = args.indexOf("--names");
const NAMES_FILE =
  namesAt === -1 ? join(AI_SUITE_DIR, "capability-names.test.ts") : args.splice(namesAt, 2)[1];
const inputPaths = args.length > 0 ? args : DEFAULT_PATHS;
const filePaths = inputPaths.flatMap((p) =>
  statSync(p).isDirectory()
    ? readdirSync(p)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .sort()
        .map((f) => join(p, f))
    : [p],
);

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

const sources = filePaths.map((p) => readFileSync(p, "utf8"));

// ── Split the registry into capability blocks ────────────────────────────
// A capability declares `name: "<snake_case>",` with `level: "…",` on the
// next line at the same indent — an array entry or a standalone const alike.
// (Parameter properties like `name: { type: "string" }` don't match — they
// have no quoted string value. The generated `_in_sub_account` wrapper uses
// a template literal, so it's excluded; its re-anchor is asserted separately.)
// Each file is split on its own, so a block never runs into the next file.
const capRe = /^( +)name: "([a-z0-9_]+)",\n\1level: "(agency|sub-account)",$/gm;
// The registered names, from the lock table's rows (`["name", "level", …]`),
// less the generated `_in_sub_account` variants. Compared with what was
// checked below (A4b review round 2: a file split moved assign_billing_plan
// out of reach of an indent-specific pattern and the check shrank silently).
const registered = [...readFileSync(NAMES_FILE, "utf8").matchAll(/^\s*\["([a-z0-9_]+)",/gm)]
  .map((m) => m[1])
  .filter((n) => !n.endsWith("_in_sub_account"));

const failures = [];
const checked = [];

for (const src of sources) {
  const matches = [...src.matchAll(capRe)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][2];
    const level = matches[i][3];
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
    const block = src.slice(start, end);
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
}

// ── Sanity: the parser must still be seeing the registry ─────────────────
const checkedNames = new Set(checked.map((c) => c.name));
const unchecked = registered.filter((n) => !checkedNames.has(n));
const unregistered = [...checkedNames].filter((n) => !registered.includes(n));
if (unchecked.length > 0 || unregistered.length > 0) {
  failures.push(
    `${registered.length} capabilities are registered (${NAMES_FILE}) but ${checked.length} were checked.` +
      (unchecked.length ? ` Not checked: ${unchecked.join(", ")} — declared in a shape this checker can't parse (it needs \`name: "…",\` then \`level: "…",\` at the same indent); fix the declaration or this checker, never let it pass unchecked.` : "") +
      (unregistered.length ? ` Checked but not in the names table: ${unregistered.join(", ")}.` : ""),
  );
}
if (checked.length < MIN_EXPECTED_CAPABILITIES) {
  failures.push(
    `Only ${checked.length} capabilities parsed (expected ≥ ${MIN_EXPECTED_CAPABILITIES}). The registry's source shape probably changed — update the parsing in this checker rather than letting it pass vacuously.`,
  );
}

// ── The generated agency wrapper must re-anchor the target sub-account ───
// inSubAccount() produces the `*_in_sub_account` variants at runtime; its
// execute must verify the model-supplied sub-account belongs to the caller's
// agency before delegating.
const src = sources.find((s) => s.includes("function inSubAccount(")) ?? "";
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
    `Checked ${checked.length} capabilities (${agencyCount} agency, ${subCount} sub-account) in ${filePaths.length} file(s): ${inputPaths.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `✓ AI Suite tenancy check passed — ${checked.length} capabilities (${agencyCount} agency, ${subCount} sub-account) all carry a tenant anchor; ${EXTERNAL_ONLY.size} justified external-only exemption(s); delegation wrapper re-anchors.`,
);
