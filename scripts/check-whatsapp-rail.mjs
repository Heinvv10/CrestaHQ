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

const NEEDLE = /twilioConfig\??\.\s*whatsappFromNumber/;

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
export function offendingLines(src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    // Prose mentioning the field is how the reasoning gets recorded — several
    // of these comments exist precisely to explain why the rail-agnostic
    // helper is used. Flagging them would push authors to delete the
    // explanation to satisfy the linter.
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (NEEDLE.test(line)) out.push({ line: i + 1, text: t });
  });
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
