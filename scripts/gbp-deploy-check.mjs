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
 *     `GBP_FAKE_*`. Fails closed on an unreadable file.
 *
 *   node scripts/gbp-deploy-check.mjs post <deploy-dir> <app-url>
 *     After the build. The app fence (src/lib/gbp/provider/mode.ts) allows the
 *     fake only when the app URL INLINED INTO THE BUILD is loopback, so this is
 *     the authoritative check: <app-url> must parse, its host must not be on the
 *     wide loopback block-list, and it must appear in every built server chunk
 *     that carries the fake-mode code. If that code cannot be found, nothing is
 *     proven and the check refuses.
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
/** Text unique to the fake-mode check in mode.ts (its refusal message). */
const MODE_MARKER = "GBP fake provider refused";

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
  const modeFiles = serverFiles.filter((f) => f.text.includes(MODE_MARKER));
  if (modeFiles.length === 0) {
    return ["the fake-provider check was not found in the built server code — nothing proven"];
  }
  return modeFiles
    .filter((f) => !f.text.includes(appUrl))
    .map((f) => `${f.path}: NEXT_PUBLIC_APP_URL is not inlined next to the fake-provider check`);
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
