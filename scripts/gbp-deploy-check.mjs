#!/usr/bin/env node
/**
 * gbp-deploy-check.mjs — keep the dev/CI-only GBP fake provider out of a
 * production deploy. Two checks, neither of which parses or expands env files
 * (three earlier designs that emulated Next's env loader each had a bypass):
 *
 *   node scripts/gbp-deploy-check.mjs pre  <deploy-dir>
 *     Before any gate or build. Refuses if the RAW TEXT of any `.env*` file in
 *     the deploy dir contains `GBP_PROVIDER` or `GBP_FAKE_` anywhere — any
 *     line, commented or not; production never needs these names (the default
 *     is Google) — or if any deploy-shell variable is NAMED `GBP_PROVIDER*` or
 *     `GBP_FAKE_*`. Also refuses unless NEXT_PUBLIC_APP_URL is mentioned on
 *     exactly one line, in .env.production only (.env.example, which Next never
 *     loads, excepted), so deploy-velo.sh's sed and Next read the same value.
 *     Fails closed on an unreadable file.
 *
 *   node scripts/gbp-deploy-check.mjs post <deploy-dir> <app-url>
 *     After the build. The app fence (src/lib/gbp/provider/mode.ts) allows the
 *     fake only when the app URL INLINED INTO THE BUILD is loopback, so this is
 *     the authoritative check: in every built server chunk carrying that check,
 *     the string literal passed to it is extracted and must EQUAL <app-url>
 *     exactly, parse, and have a host off the wide loopback block-list. A check
 *     whose literal cannot be read, or no check at all, refuses (fail closed).
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

const FAKE_NAME = /GBP_PROVIDER|GBP_FAKE_/;
const FAKE_VAR_NAME = /^(GBP_PROVIDER|GBP_FAKE_)/;
/** The refusal message thrown by mode.ts's app-loopback check — its anchor. */
const CHECK_MESSAGE = "NEXT_PUBLIC_APP_URL is not a loopback host";
/**
 * The literal the build passed to that check: `…("<url>"))throw new X("<CHECK_MESSAGE>")`.
 * Matches both shapes the minifier has produced (`(0,t.isAppLoopbackUrl)("…")`
 * and an inlined `function(e){…}("…")`). Captures a double-quoted JS string.
 */
const INLINED_LITERAL = new RegExp(
  String.raw`\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*\)\s*throw\s+new\s+[\w$]+\(\s*["'\x60]` +
    CHECK_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "g",
);
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
    if (FAKE_NAME.test(text)) problems.push(`${name}: mentions GBP_PROVIDER or GBP_FAKE_*`);
    // deploy-velo.sh reads NEXT_PUBLIC_APP_URL with sed (first line of
    // .env.production); Next takes the LAST definition and lets .env.local /
    // .env.production.local win. Allow exactly one line, in one file, so the
    // two readings cannot differ.
    if (TEMPLATES.has(name)) continue;
    const appUrlLines = text.split(/\r?\n/).filter((l) => l.includes("NEXT_PUBLIC_APP_URL")).length;
    if (name === ".env.production" && appUrlLines > 1) {
      problems.push(`${name}: NEXT_PUBLIC_APP_URL appears on ${appUrlLines} lines — exactly one allowed`);
    } else if (name !== ".env.production" && appUrlLines > 0) {
      problems.push(`${name}: NEXT_PUBLIC_APP_URL must be set only in .env.production`);
    }
  }
  for (const key of Object.keys(shellEnv)) {
    if (FAKE_VAR_NAME.test(key)) problems.push(`deploy shell: ${key} is set`);
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
  let checks = 0;
  for (const file of serverFiles) {
    const expected = file.text.split(CHECK_MESSAGE).length - 1;
    if (expected === 0) continue;
    const literals = [...file.text.matchAll(INLINED_LITERAL)].map((m) => m[1]);
    // Every occurrence of the check must yield its literal; otherwise the build
    // passes something we cannot read (e.g. a runtime env lookup) — refuse.
    if (literals.length !== expected) {
      problems.push(`${file.path}: could not read the URL literal passed to the fake-provider check`);
      continue;
    }
    for (const raw of literals) {
      checks += 1;
      let literal;
      try {
        literal = JSON.parse(raw);
      } catch {
        problems.push(`${file.path}: could not read the URL literal passed to the fake-provider check`);
        continue;
      }
      // EXACT equality: a substring match let `https://crm.crestahq.com@127.0.0.1:4300`
      // (userinfo → loopback host) pass for `https://crm.crestahq.com`.
      // (Equal to an appUrl already shown to parse and be off the loopback
      // block-list, so the literal is too — no second host check needed.)
      if (literal !== appUrl) {
        problems.push(`${file.path}: the URL inlined into the fake-provider check is not NEXT_PUBLIC_APP_URL`);
      }
    }
  }
  if (checks === 0 && problems.length === 0) {
    return ["the fake-provider check was not found in the built server code — nothing proven"];
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
    if (mode === "pre" && dir) problems = mentionsFakeKeys(path.resolve(dir), process.env);
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
    console.error("The GBP fake provider is dev/CI only — it must not reach a production deploy.");
    process.exit(1);
  }
  console.log(`GBP deploy check (${mode}): clean`);
}
