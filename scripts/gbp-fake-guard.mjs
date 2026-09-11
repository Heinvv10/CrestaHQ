#!/usr/bin/env node
/**
 * gbp-fake-guard.mjs — refuse a production deploy carrying the GBP fake provider.
 *
 *   node scripts/gbp-fake-guard.mjs <deploy-dir>     (exit 0 = clean, 1 = refused)
 *
 * The deterministic fake Google Business Profile provider is dev/CI only. The
 * app refuses it on a non-loopback NEXT_PUBLIC_APP_URL, in a production build
 * without GBP_FAKE_ALLOW_PROD_BUILD=1, and outside GBP_FAKE_AGENCY_ID
 * (src/lib/gbp/provider/select.ts). This is the second, independent layer:
 * the production deploy refuses to build with any of it configured.
 *
 * It loads the deploy dir's env files EXACTLY as Next does — @next/env's
 * loadEnvConfig in production mode (.env.production.local, .env.local,
 * .env.production, .env) — so every dotenv spelling that reaches the app
 * reaches this check too — in a child process with GBP_* and
 * NEXT_PUBLIC_APP_URL stripped, so each file is judged on its OWN value. It
 * refuses when the merged env (process env over files, Next's precedence) OR
 * any single file:
 *   - sets GBP_PROVIDER to "fake" (case-insensitive, trimmed),
 *   - sets any GBP_FAKE_* variable,
 *   - sets a NEXT_PUBLIC_APP_URL whose host is loopback (the shared rule in
 *     src/lib/gbp/provider/loopback.mjs), or one that does not parse.
 * Every file is checked on its own because the service's runtime environment
 * is not this deploy shell's: a file value the shell happens to shadow can
 * still reach the running app. Fails CLOSED on an unreadable env file.
 *
 * Not read: systemd `Environment=` / `EnvironmentFile=` lines on the unit. The
 * app-side fence is the independent layer for those.
 *
 * Prints variable NAMES and file names only — never values.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLoopbackHostname } from "../src/lib/gbp/provider/loopback.mjs";

const require = createRequire(import.meta.url);

/** @next/env is Next's own dependency: load the exact copy Next uses. */
function nextEnv() {
  const nextDir = path.dirname(require.resolve("next/package.json"));
  return require(require.resolve("@next/env", { paths: [nextDir] }));
}

/** Keys whose shell value must never shadow what a FILE says. */
const GUARDED_KEY = /^(GBP_|NEXT_PUBLIC_APP_URL$)/i;

/**
 * In a child process: the env files Next would load for a production build of
 * `dir`, each with its own parsed (and expanded) values, plus read errors.
 * Printed as JSON on stdout for the parent — never shown to a person.
 */
function childLoadFiles(dir) {
  const errors = [];
  let files = [];
  try {
    const log = { info() {}, error: (msg) => errors.push(String(msg)) };
    files = nextEnv()
      .loadEnvConfig(dir, false, log, true)
      .loadedEnvFiles.map((f) => ({ path: f.path, env: f.env ?? {} }));
  } catch (err) {
    errors.push(`could not load env: ${err instanceof Error ? err.name : typeof err}`);
  }
  process.stdout.write(JSON.stringify({ files, errors }));
}

/**
 * Load `dir`'s env files in a CHILD process whose environment has every GBP_*
 * key and NEXT_PUBLIC_APP_URL removed. @next/env lets the process env win over
 * file values (and snapshots it once per process), so loading in-process would
 * report a file's `GBP_PROVIDER=fake` as whatever the deploy shell exported —
 * a shell `GBP_PROVIDER=google` would hide it. The child sees each file's OWN
 * value. Any failure of the child fails closed.
 */
function loadFiles(dir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!GUARDED_KEY.test(key)) env[key] = value;
  }
  env.NODE_ENV = "production"; // "test" would make @next/env load .env.test instead
  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--load-files", dir], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  try {
    // The child prints one complete JSON document as its last act; a crashed,
    // killed or never-started child leaves nothing parseable.
    const parsed = JSON.parse(res.stdout);
    return { files: parsed.files, errors: parsed.errors };
  } catch {
    return { files: [], errors: ["the env loader did not complete"] };
  }
}

/** Problems in one env map, as human-readable names (never values). */
function problemsIn(env, where) {
  const out = [];
  if (String(env.GBP_PROVIDER ?? "").trim().toLowerCase() === "fake") {
    out.push(`${where}: GBP_PROVIDER is set to fake`);
  }
  for (const key of Object.keys(env)) {
    if (/^GBP_FAKE_/i.test(key)) out.push(`${where}: ${key} is set`);
  }
  const url = env.NEXT_PUBLIC_APP_URL;
  if (url !== undefined && String(url).trim() !== "") {
    let host = null;
    try {
      host = new URL(String(url).trim()).hostname;
    } catch {
      out.push(`${where}: NEXT_PUBLIC_APP_URL does not parse as a URL`);
    }
    if (host !== null && isLoopbackHostname(host)) {
      out.push(`${where}: NEXT_PUBLIC_APP_URL is a loopback address`);
    }
  }
  return out;
}

/**
 * @param {string} dir  the deploy checkout
 * @param {Record<string, string | undefined>} baseEnv  the deploy shell's env
 * @returns {string[]} problems; empty = clean
 */
export function guardDeployDir(dir, baseEnv = process.env) {
  const { files, errors } = loadFiles(dir);
  const problems = errors.map((e) => `unreadable env file (${e})`);
  // Next's precedence: the process env wins, then the first file that sets a key.
  const merged = { ...baseEnv };
  for (const file of files) {
    for (const [key, value] of Object.entries(file.env ?? {})) {
      if (merged[key] === undefined) merged[key] = value;
    }
    problems.push(...problemsIn(file.env ?? {}, file.path));
  }
  problems.push(...problemsIn(merged, "merged env"));
  return [...new Set(problems)];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain && process.argv[2] === "--load-files") {
  childLoadFiles(path.resolve(process.argv[3]));
} else if (isMain) {
  let problems;
  try {
    problems = guardDeployDir(path.resolve(process.argv[2] ?? process.cwd()));
  } catch (err) {
    problems = [`guard failed: ${err instanceof Error ? err.name : typeof err}`];
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`refused: ${p}`);
    console.error("The GBP fake provider is dev/CI only — remove these settings from the deploy dir.");
    process.exit(1);
  }
  console.log("GBP fake-provider guard: clean");
}
