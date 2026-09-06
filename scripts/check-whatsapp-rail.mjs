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
 * Nothing in the type system prevents that, so this script does: any .tsx
 * under src/ that reads `twilioConfig?.whatsappFromNumber` fails the lint
 * unless it is listed below. It is a source inspection, in the same spirit as
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
 */
const ALLOWED = new Map([
  [
    "components/settings/sub-account-sms-section.tsx",
    "The Twilio settings form itself: it reads and writes that field.",
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
const FIELD =
  /twilioConfig\s*\??\.\s*(?:whatsappFromNumber|\[\s*["']whatsappFromNumber["']\s*\])/;
const DESTRUCTURE = /\{[^}]*\bwhatsappFromNumber\b[^}]*\}\s*=\s*[^;]*twilioConfig/;
// NOT scanned here yet: `subAccountWhatsappIsConfigured(...)` standing in for
// readiness in server code. Blind review found two routes doing it, fixed in
// this PR, and the same rule then flags four more genuine cases in workflow
// and review code whose rail support needs its own analysis (a template node
// cannot run on the bridge, but CAN on Cloud). That rule lands with the PR
// that fixes them — a gate is not allowed to ship red with an allowlist
// papering over real bugs, and a warning budget would only ratchet.
// Tracked in the follow-up issue.

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) out.push(full);
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
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    // A JSDoc continuation line, which survives when a block comment's opener
    // is not in the same slice of source (and is what a unit test passes).
    .map((l) => (/^\s*\*/.test(l) ? "" : l))
    .join("\n");
}

export function offendingLines(src) {
  const clean = stripComments(src);
  const out = [];

  clean.split("\n").forEach((line, i) => {
    if (FIELD.test(line)) {
      out.push({ line: i + 1, text: line.trim() });
    }
  });

  // Forms that span lines: Prettier breaks long chains, and a destructure or
  // an intermediate variable hides the field from any single-line test. Match
  // against the whole file with whitespace collapsed, and report the first
  // line naming the field so the message still points somewhere useful.
  const flat = clean.replace(/\s+/g, " ");
  if (
    (FIELD.test(flat) || DESTRUCTURE.test(flat)) &&
    out.every((o) => !FIELD.test(o.text))
  ) {
    const idx = clean
      .split("\n")
      .findIndex((l) => /whatsappFromNumber|twilioConfig/.test(l));
    out.push({
      line: idx + 1,
      text: "(multi-line or destructured) reads twilioConfig.whatsappFromNumber",
    });
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
  if (ALLOWED.has(rel)) continue;
  const src = readFileSync(file, "utf8");
  for (const o of offendingLines(src)) {
    offenders.push(`${rel}:${o.line}: ${o.text}`);
  }
}

if (offenders.length > 0) {
  console.error(
    "\nWhatsApp readiness must be rail-agnostic. These read the Twilio-only\n" +
      "field, which hides the channel on a correctly connected Cloud or bridge\n" +
      "workspace. Use whatsappSenderConfigured() from\n" +
      "src/lib/comms/whatsapp/sender-configured.ts instead:\n",
  );
  for (const o of offenders) console.error("  " + o);
  console.error(
    "\nIf a file is genuinely Twilio-specific, add it to ALLOWED in\n" +
      "scripts/check-whatsapp-rail.mjs with a reason.\n",
  );
  process.exit(1);
}
console.log("whatsapp rail check: no Twilio-only readiness gates in .tsx");
}
