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
 * reaches this check too. It refuses when the merged env (process env over
 * files, Next's precedence) OR any single file:
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

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHostname } from "../src/lib/gbp/provider/loopback.mjs";

const require = createRequire(import.meta.url);

/** @next/env is Next's own dependency: load the exact copy Next uses. */
function nextEnv() {
  const nextDir = path.dirname(require.resolve("next/package.json"));
  return require(require.resolve("@next/env", { paths: [nextDir] }));
}

/**
 * The env files Next would load for a production build of `dir`, and any read
 * errors. process.env is restored afterwards (loadEnvConfig mutates it).
 */
function loadFiles(dir) {
  const errors = [];
  const saved = { ...process.env };
  let files = [];
  try {
    process.env.NODE_ENV = "production"; // "test" would load .env.test instead
    const log = { info() {}, error: (msg) => errors.push(String(msg)) };
    files = nextEnv().loadEnvConfig(dir, false, log, true).loadedEnvFiles;
  } catch (err) {
    errors.push(`could not load env: ${err instanceof Error ? err.name : typeof err}`);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return { files, errors };
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
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
