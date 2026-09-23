#!/usr/bin/env node
/**
 * Rail-agnostic WhatsApp readiness check.
 *
 * A workspace sends WhatsApp over one of three rails — Twilio, Cloud, or the
 * self-hosted bridge — and only the Twilio one stores a
 * `twilioConfig.whatsappFromNumber`. So a UI that asks for that field is not
 * applying a stricter test, it is applying the WRONG one: it refuses a
 * workspace that is correctly connected and offers no explanation.
 *
 * This is not hypothetical. On 2026-09-06 a real inbound reached a bridge
 * workspace's thread and the composer rendered "No messaging channel is
 * configured", because five separate components each asked for a Twilio
 * number. `whatsappSenderConfigured` had existed since the provider seam
 * landed and had ONE caller; a second file had even shadowed its name with a
 * local `const whatsappSenderConfigured = !!twilioConfig?.whatsappFromNumber`,
 * so the seam looked wired while every surface bypassed it.
 *
 * Nothing in the type system prevents that, so this script does: any .ts or
 * .tsx under src/ that so much as NAMES `whatsappFromNumber` or
 * `subAccountWhatsappIsConfigured` in code fails the lint unless it is listed
 * below. Mention, not use — the rule cannot tell a call from a reference, and
 * deliberately does not try. It is a source inspection, in the same spirit as
 * check-capability-tenancy.mjs — it proves the wrong check is ABSENT, not that
 * the right one is correct.
 *
 * Runs as part of `pnpm lint`. Zero dependencies.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "src");

/**
 * Files allowed to read the Twilio field directly. Every entry needs a reason,
 * and the reason must be that the file is about TWILIO SPECIFICALLY — never
 * that converting it was inconvenient.
 *
 * SEPARATE per rule. Widening the walk to `.ts` brought in server files that
 * legitimately touch one of the two shapes; sharing one allowlist between the
 * rules would let a Twilio-internals exemption silently excuse a rail-blind
 * readiness gate in the same file, which is the exact defect this gate exists
 * to catch.
 */
const ALLOWED_FIELD = new Map([
  [
    "components/settings/sub-account-sms-section.tsx",
    "The Twilio settings form itself: it reads and writes that field.",
  ],
  [
    "types/tenancy.ts",
    "Declares TwilioConfig — the field's own type definition.",
  ],
  [
    "lib/comms/twilio.ts",
    "The Twilio client: the field IS its sender number.",
  ],
  [
    "lib/comms/whatsapp/resolve-sender.ts",
    "The sender resolver itself. It reads the field only in the `default:` (Twilio) branch of the per-rail number lookup that synthesizes a legacy sub-account's sender — the correct value for that rail.",
  ],
  [
    "lib/comms/whatsapp/sender-configured.ts",
    "The rail-agnostic helper itself. It reads the field only in its `default:` (Twilio) branch, which is the correct value for that rail.",
  ],
  [
    "app/api/sub-accounts/[id]/twilio/whatsapp/route.ts",
    "The Twilio WhatsApp connect route: it writes that field.",
  ],
  [
    "app/api/webhooks/twilio/whatsapp/inbound/route.ts",
    "Twilio's own inbound webhook — it matches the payload against the Twilio sender.",
  ],
  [
    "app/api/webhooks/twilio/whatsapp/status/route.ts",
    "Twilio's own statusCallback webhook — it matches the payload against the Twilio sender.",
  ],
]);

const ALLOWED_HELPER = new Map([
  [
    "lib/comms/twilio.ts",
    "Defines subAccountWhatsappIsConfigured and uses it to guard Twilio's own send calls.",
  ],
  [
    "lib/comms/whatsapp/readiness.ts",
    "Calls it inside the Twilio branch of the rail-aware readiness check — which is what every other caller should use instead.",
  ],
  [
    "app/api/sub-accounts/[id]/whatsapp-templates/[templateId]/submit/route.ts",
    "Guarded by `provider === \"twilio\"`: submitting a template to Twilio's Content API needs Twilio credentials specifically.",
  ],
  [
    "test/reviews-request-harness.ts",
    "A vi.fn() test double standing in for the Twilio module's export. Not named *.test.ts, so the walk sees it; allowlisted by name rather than excluding all of src/test/, which would be a hole.",
  ],
]);

/**
 * Two rules, because the same defect wears two shapes.
 *
 * FIELD — reading `twilioConfig.whatsappFromNumber` to decide whether WhatsApp
 * is available. Only the Twilio rail stores it.
 *
 * HELPER — `subAccountWhatsappIsConfigured(...)` standing in for readiness.
 * It requires accountSid + authToken + whatsappFromNumber, so it is false for
 * every correctly connected Cloud or bridge workspace. Blind review found two
 * routes doing this on 2026-09-06: a Cloud workspace could not send a template
 * or enable the AI WhatsApp channel, and was told to add a Twilio number.
 */
// Name-based, not chain-based: the rule is "does this file mention the
// Twilio-only field at all", not "does it read it through a chain I thought
// of". The earlier chain-shaped matcher missed `const cfg = sub?.twilioConfig`
// followed by `cfg?.whatsappFromNumber` — the form BOTH files that mattered
// actually used — so the allowlist entry was never exercised and a live bug in
// a scanned .tsx was invisible. Matching the bare name survives an import
// alias and an intermediate `const check = subAccountWhatsappIsConfigured`.
//
// What this does NOT buy. It is a source inspection over a fixed pair of
// identifiers, so three shapes defeat it, all confirmed by blind review:
//
//   1. An identifier assembled at runtime —
//      `(twilio as any)["subAccountWhatsapp" + "IsConfigured"](…)`.
//   2. The defect written out fresh with neither name —
//      `!!sub?.twilioConfig?.accountSid && !!sub?.twilioConfig?.authToken`.
//   3. An alias RE-EXPORTED from an allowlisted file. `lib/comms/twilio.ts` is
//      listed under both rules, so `export const waReady =
//      subAccountWhatsappIsConfigured` there makes every consumer invisible.
//
// (1) and (2) take deliberate effort; (3) is the one an author could hit by
// accident, so treat an allowlisted file as a place that must not grow new
// exports of these checks. Chasing any of the three with more pattern matching
// would add complexity a name-based scan cannot cash — the gate's job is to
// keep the ORDINARY spelling of the wrong check out of new code, and it is a
// backstop for review, not a replacement for it.
const FIELD = /\bwhatsappFromNumber\b/;
const HELPER = /\bsubAccountWhatsappIsConfigured\b/;

/**
 * Which filenames the walk inspects, as a pure predicate so the extension set
 * is actually TESTED. `.ts` matters as much as `.tsx`: the send paths this
 * gate exists to police are server modules, and narrowing back to `.tsx` alone
 * would leave the walk running, the output green, and every one of them
 * unscanned. Tests are excluded because a test's whole job may be to write the
 * wrong check down.
 */
export function shouldScan(filename) {
  return (
    (filename.endsWith(".ts") || filename.endsWith(".tsx")) &&
    !filename.endsWith(".test.ts") &&
    !filename.endsWith(".test.tsx")
  );
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (shouldScan(entry)) out.push(full);
  }
  return out;
}

/**
 * The whole decision, as a pure function, so it can be tested. Inlining it in
 * the walk loop is what let an earlier version's comment-skip swallow real
 * code with nothing to notice.
 */
/**
 * Strip comments, then test. Prose mentioning these names is how the reasoning
 * gets recorded — several such comments exist precisely to explain why the
 * rail-agnostic helper is used — and flagging them would push authors to
 * delete the explanation to satisfy the linter.
 */
function stripComments(src) {
  return src
    // Blank a block comment, do not DELETE it: removing its newlines shifts
    // every line number after it, and the reported `file:line` is the whole
    // value of a blocking gate's output. Replace each block with the same
    // count of newlines it spanned.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    // A JSDoc continuation line, which survives when a block comment's opener
    // is not in the same slice of source (and is what a unit test passes).
    .map((l) => (/^\s*\*/.test(l) ? "" : l))
    .join("\n");
}

/**
 * @param src   file source
 * @param rules which rules to apply. The two have SEPARATE allowlists, so the
 *              caller runs them independently; both are on by default because
 *              a bare call should be the strictest reading.
 */
export function offendingLines(src, rules = { field: true, helper: true }) {
  const clean = stripComments(src);
  const lines = clean.split("\n");
  const out = [];

  const apply = (re, rule, aliasText) => {
    const before = out.length;
    lines.forEach((line, i) => {
      if (re.test(line)) out.push({ line: i + 1, rule, text: line.trim() });
    });
    // Forms that span lines: Prettier breaks long chains, and a destructure or
    // an intermediate variable hides the name from any single-line test. Match
    // against the whole file with whitespace collapsed, and report the first
    // line naming it so the message still points somewhere useful.
    if (out.length === before && re.test(clean.replace(/\s+/g, " "))) {
      out.push({
        line: lines.findIndex((l) => re.test(l)) + 1,
        rule,
        text: aliasText,
      });
    }
  };

  if (rules.field !== false) {
    apply(
      FIELD,
      "field",
      "(aliased or multi-line) reads the Twilio-only whatsappFromNumber",
    );
  }
  if (rules.helper !== false) {
    apply(
      HELPER,
      "helper",
      "(aliased or multi-line) calls subAccountWhatsappIsConfigured",
    );
  }
  return out;
}

// Importing this module for its pure export must not run the walk.
const isEntrypoint =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (!isEntrypoint) {
  // exported-only use
} else {
const offenders = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split("\\").join("/");
  const rules = {
    field: !ALLOWED_FIELD.has(rel),
    helper: !ALLOWED_HELPER.has(rel),
  };
  if (!rules.field && !rules.helper) continue;
  const src = readFileSync(file, "utf8");
  for (const o of offendingLines(src, rules)) {
    offenders.push(`[${o.rule}] ${rel}:${o.line}: ${o.text}`);
  }
}

if (offenders.length > 0) {
  console.error(
    "\nWhatsApp readiness must be rail-agnostic. These read the Twilio-only\n" +
      "field, or call the Twilio-only subAccountWhatsappIsConfigured(), which\n" +
      "hides the channel on a correctly connected Cloud or bridge workspace.\n" +
      "Use whatsappSenderConfigured() from\n" +
      "src/lib/comms/whatsapp/sender-configured.ts (pure, client-safe), or\n" +
      "checkWhatsappReadiness() from src/lib/comms/whatsapp/readiness.ts on a\n" +
      "send path, instead:\n",
  );
  for (const o of offenders) console.error("  " + o);
  console.error(
    "\nIf a file is genuinely Twilio-specific, add it to ALLOWED_FIELD or\n" +
      "ALLOWED_HELPER in scripts/check-whatsapp-rail.mjs with a reason.\n",
  );
  process.exit(1);
}
console.log("whatsapp rail check: no Twilio-only readiness gates in .ts/.tsx");
}
