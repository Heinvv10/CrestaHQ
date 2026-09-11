#!/usr/bin/env node
/**
 * gbp-deploy-check.mjs — keep the dev/CI-only fake providers (GBP, and the
 * WhatsApp settings fake that mirrors its fence) out of a production deploy.
 * Two checks, neither of which parses or expands env files (three earlier
 * designs that emulated Next's env loader each had a bypass):
 *
 *   node scripts/gbp-deploy-check.mjs pre  <deploy-dir>
 *     Before any gate or build. Refuses if the RAW TEXT of any `.env*` file in
 *     the deploy dir contains `GBP_PROVIDER`, `GBP_FAKE_`,
 *     `WHATSAPP_SETTINGS_PROVIDER` or `WHATSAPP_FAKE_` anywhere — any line,
 *     commented or not; production never needs these names (the defaults are
 *     Google and Meta) — or if any deploy-shell variable is NAMED so.
 *     Also refuses if NEXT_PUBLIC_APP_URL is DEFINED more than
 *     once in .env.production, or defined in any other env file (.env.example,
 *     which Next never loads, excepted; comments never count), so
 *     deploy-velo.sh's sed and Next read the same value.
 *     And a POSITIVE check: TRUST_CF_CONNECTING_IP must be defined, as exactly
 *     `1`, in a production env file — and nowhere as anything else. velo is
 *     reachable only through the cloudflared tunnel, and without it the public
 *     reviews feed's rate limiter keys on headers a visitor controls.
 *     Fails closed on an unreadable file.
 *
 *   node scripts/gbp-deploy-check.mjs post <deploy-dir> <app-url>
 *     After the build. Each app fence (src/lib/gbp/provider/mode.ts and
 *     src/lib/comms/whatsapp/settings/mode.ts) allows its fake only when the
 *     app URL INLINED INTO THE BUILD is loopback, so this is the authoritative
 *     check: in every built server chunk carrying either check, the string
 *     literal passed to it is extracted and must EQUAL <app-url> exactly,
 *     parse, and have a host off the wide loopback block-list. A check whose
 *     literal cannot be read, or EITHER check absent from the build, refuses
 *     (fail closed).
 *
 * Not covered: systemd `Environment=` lines on the unit. They cannot change
 * the inlined URL, so the app fence plus the post-build check still hold.
 *
 * Prints file and variable NAMES only — never values. Exit 0 clean, 1 refused,
 * 2 usage error.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHostname } from "../src/lib/gbp/provider/loopback.mjs";

const FAKE_NAME = /GBP_PROVIDER|GBP_FAKE_|WHATSAPP_SETTINGS_PROVIDER|WHATSAPP_FAKE_/;
const FAKE_VAR_NAME = /^(GBP_PROVIDER|GBP_FAKE_|WHATSAPP_SETTINGS_PROVIDER|WHATSAPP_FAKE_)/;
/**
 * The refusal message each mode.ts throws from its app-loopback check — the
 * anchor the post-build scan finds it by. Neither may be a substring of the
 * other, or one check's occurrences would be counted for both.
 */
const CHECKS = [
  { label: "GBP", message: "NEXT_PUBLIC_APP_URL is not a loopback host" },
  { label: "WhatsApp", message: "NEXT_PUBLIC_APP_URL is not loopback (WhatsApp fake)" },
];
/**
 * The literal the build passed to a check: `…("<url>"))throw new X("<message>")`.
 * Matches both shapes the minifier has produced (`(0,t.isAppLoopbackUrl)("…")`
 * and an inlined `function(e){…}("…")`). Captures a double-quoted JS string.
 * Real builds double-quote both the literal and the message; any other quoting
 * does not match and fails closed ("could not read").
 * @param {string} message
 */
const inlinedLiteral = (message) =>
  new RegExp(
    String.raw`\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*\)\s*throw\s+new\s+[\w$]+\(\s*"` +
      message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "g",
  );
/** A dotenv DEFINITION of the app URL (`KEY=`, `KEY:`, optional export/spaces). */
const APP_URL_DEFINITION = /^\s*(export\s+)?NEXT_PUBLIC_APP_URL\s*[=:]/;
/** Env files Next never loads; a template may name any key. */
const TEMPLATES = new Set([".env.example"]);

/**
 * (a) PRE-BUILD.
 * @param {string} dir  the deploy checkout
 * @param {Record<string, string | undefined>} shellEnv
 * @returns {string[]} problems; empty = clean
 */
export function mentionsFakeKeys(dir, shellEnv) {
  const problems = [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(".env"));
  } catch {
    return [`cannot list ${dir}`];
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let text;
    try {
      if (fs.statSync(file).isDirectory()) continue; // Next never loads a directory
      text = fs.readFileSync(file, "utf8");
    } catch {
      problems.push(`${name}: unreadable env file`);
      continue;
    }
    if (FAKE_NAME.test(text)) {
      problems.push(`${name}: mentions GBP_PROVIDER / GBP_FAKE_* / WHATSAPP_SETTINGS_PROVIDER / WHATSAPP_FAKE_*`);
    }
    // deploy-velo.sh reads NEXT_PUBLIC_APP_URL with sed (first line of
    // .env.production); Next takes the LAST definition and lets .env.local /
    // .env.production.local win. Allow ONE definition, in one file, so the two
    // readings cannot differ. Comments never count (the production file keeps
    // one copied from .env.example); a lone CR, U+2028 and U+2029 break a line,
    // as they do for dotenv's multiline regex.
    if (TEMPLATES.has(name)) continue;
    const definitions = text.split(/\r\n?|[\n\u2028\u2029]/).filter((l) => APP_URL_DEFINITION.test(l)).length;
    if (name === ".env.production" && definitions > 1) {
      problems.push(`${name}: NEXT_PUBLIC_APP_URL is defined ${definitions} times — exactly one allowed`);
    } else if (name !== ".env.production" && definitions > 0) {
      problems.push(`${name}: NEXT_PUBLIC_APP_URL must be defined only in .env.production`);
    }
  }
  for (const key of Object.keys(shellEnv)) {
    if (FAKE_VAR_NAME.test(key)) problems.push(`deploy shell: ${key} is set`);
  }
  return problems;
}

const TRUST_DEFINITION = /^\s*(?:export\s+)?TRUST_CF_CONNECTING_IP\s*[=:]\s*(.*?)\s*$/;

/**
 * (a) PRE-BUILD, positive: TRUST_CF_CONNECTING_IP=1 is set, and never set to
 * anything else (Next lets a later file win). Quotes around the 1 are allowed.
 * @param {string} dir  the deploy checkout
 * @returns {string[]} problems; empty = clean
 */
export function trustsCfConnectingIp(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(".env") && !TEMPLATES.has(n));
  } catch {
    return [`cannot list ${dir}`];
  }
  const problems = [];
  let good = 0;
  for (const name of names) {
    let text;
    try {
      if (fs.statSync(path.join(dir, name)).isDirectory()) continue;
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue; // mentionsFakeKeys already refuses an unreadable env file
    }
    for (const line of text.split(/\r\n?|[\n\u2028\u2029]/)) {
      const m = TRUST_DEFINITION.exec(line);
      if (!m) continue;
      if (/^(1|"1"|'1')$/.test(m[1])) good += 1;
      else problems.push(`${name}: TRUST_CF_CONNECTING_IP must be exactly 1`);
    }
  }
  if (good === 0 && problems.length === 0) {
    problems.push("TRUST_CF_CONNECTING_IP=1 is not set in the production env — the reviews feed's rate limiter would key on headers visitors control");
  }
  return problems;
}

/**
 * (b) POST-BUILD.
 * @param {string} appUrl  NEXT_PUBLIC_APP_URL as the build inlined it
 * @param {{ path: string, text: string }[]} serverFiles  built server JS
 * @returns {string[]} problems; empty = clean
 */
export function inlinedUrlIsSafe(appUrl, serverFiles) {
  let host;
  try {
    host = new URL(String(appUrl).trim()).hostname;
  } catch {
    return ["NEXT_PUBLIC_APP_URL does not parse as a URL"];
  }
  if (isLoopbackHostname(host)) return ["NEXT_PUBLIC_APP_URL is a loopback address"];

  const problems = [];
  for (const { label, message } of CHECKS) {
    const re = inlinedLiteral(message);
    let checks = 0;
    for (const file of serverFiles) {
      const expected = file.text.split(message).length - 1;
      if (expected === 0) continue;
      const literals = [...file.text.matchAll(re)].map((m) => m[1]);
      // Every occurrence of the check must yield its literal; otherwise the build
      // passes something we cannot read (e.g. a runtime env lookup) — refuse.
      if (literals.length !== expected) {
        problems.push(`${file.path}: could not read the URL literal passed to the ${label} fake-provider check`);
        continue;
      }
      for (const raw of literals) {
        checks += 1;
        let literal;
        try {
          literal = JSON.parse(raw);
        } catch {
          problems.push(`${file.path}: could not read the URL literal passed to the ${label} fake-provider check`);
          continue;
        }
        // EXACT equality: a substring match let `https://crm.crestahq.com@127.0.0.1:4300`
        // (userinfo → loopback host) pass for `https://crm.crestahq.com`.
        // (Equal to an appUrl already shown to parse and be off the loopback
        // block-list, so the literal is too — no second host check needed.)
        if (literal !== appUrl) {
          problems.push(`${file.path}: the URL inlined into the ${label} fake-provider check is not NEXT_PUBLIC_APP_URL`);
        }
      }
    }
    if (checks === 0) {
      problems.push(`the ${label} fake-provider check was not found in the built server code — nothing proven`);
    }
  }
  return problems;
}

function serverJs(dir) {
  const root = path.join(dir, ".next", "server");
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".js")) out.push({ path: path.relative(dir, p), text: fs.readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const [mode, dir, appUrl] = process.argv.slice(2);
  let problems;
  try {
    if (mode === "pre" && dir) problems = [...mentionsFakeKeys(path.resolve(dir), process.env), ...trustsCfConnectingIp(path.resolve(dir))];
    else if (mode === "post" && dir && appUrl !== undefined) problems = inlinedUrlIsSafe(appUrl, serverJs(path.resolve(dir)));
    else {
      console.error("usage: gbp-deploy-check.mjs pre <dir> | post <dir> <app-url>");
      process.exit(2);
    }
  } catch (err) {
    problems = [`check failed: ${err instanceof Error ? err.name : typeof err}`];
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`refused: ${p}`);
    console.error("GBP deploy check refused. The fake providers (GBP, WhatsApp settings) are dev/CI only; TRUST_CF_CONNECTING_IP=1 belongs in velo's production env. See docs/features/gbp-reviews.md.");
    process.exit(1);
  }
  console.log(`GBP deploy check (${mode}): clean`);
}
