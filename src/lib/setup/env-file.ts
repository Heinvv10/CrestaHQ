import "server-only";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Local `.env.local` writer for the setup form's "update both" mode.
 *
 * Only meaningful when the app is running on a developer's machine (`pnpm
 * dev`). On Vercel the filesystem is ephemeral/read-only and there's no local
 * dev process to feed, so `isLocalDev()` is false there and the form never
 * offers this target.
 *
 * v1 assumes single-line values (API keys) — the form is for the credential
 * long-tail, not multi-line pasted PEM keys. Values containing whitespace,
 * quotes, `#`, or `=` are double-quoted so a `.env` parser reads them back
 * intact.
 */

const ENV_LOCAL_PATH = resolve(process.cwd(), ".env.local");

/**
 * True when running locally rather than on a Vercel deployment. Vercel sets
 * `process.env.VERCEL === "1"` in every build + runtime; locally it's unset.
 */
export function isLocalDev(): boolean {
  return process.env.VERCEL !== "1";
}

function needsQuoting(value: string): boolean {
  return /[\s#"'=]/.test(value) || value === "";
}

/** Serialize one `KEY=value` assignment in `.env` shape (quoting when needed). */
export function formatEnvLine(key: string, value: string): string {
  if (!needsQuoting(value)) return `${key}=${value}`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

/** Matches an assignment line for `key`, tolerating an `export ` prefix. */
function lineMatcher(key: string): RegExp {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:export\\s+)?${esc}\\s*=`);
}

export interface EnvFileResult {
  key: string;
  ok: boolean;
  action?: "created" | "updated";
  error?: string;
}

/**
 * Merge the given vars into `.env.local`, updating existing assignments in
 * place and appending new ones. Preserves every other line (comments, blanks,
 * unrelated keys). Writes the file exactly once. Returns a per-key result.
 */
export function writeEnvLocalVars(
  vars: { key: string; value: string }[],
): EnvFileResult[] {
  const results: EnvFileResult[] = [];
  let text = "";
  try {
    if (existsSync(ENV_LOCAL_PATH)) text = readFileSync(ENV_LOCAL_PATH, "utf8");
  } catch (e) {
    // If we can't even read it, fail every key rather than clobbering.
    return vars.map((v) => ({
      key: v.key,
      ok: false,
      error: `Couldn't read .env.local: ${(e as Error).message}`,
    }));
  }

  const lines = text.split(/\r?\n/);
  for (const { key, value } of vars) {
    const formatted = formatEnvLine(key, value);
    const idx = lines.findIndex((l) => lineMatcher(key).test(l));
    if (idx >= 0) {
      lines[idx] = formatted;
      results.push({ key, ok: true, action: "updated" });
    } else {
      // Drop a single trailing blank so appends don't accumulate gaps.
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
      }
      lines.push(formatted);
      results.push({ key, ok: true, action: "created" });
    }
  }

  try {
    writeFileSync(ENV_LOCAL_PATH, lines.join("\n") + "\n", "utf8");
  } catch (e) {
    // The write failed → the whole batch is untrustworthy.
    return vars.map((v) => ({
      key: v.key,
      ok: false,
      error: `Couldn't write .env.local: ${(e as Error).message}`,
    }));
  }

  return results;
}

export interface StoredEnvLine {
  /** The normalized `KEY=<rhs>` line, RHS preserved verbatim (quotes/escapes). */
  line: string;
  /** Best-effort unquoted value, for a presence check only. */
  value: string;
}

/**
 * Parse `.env.local` into a per-key map of its raw assignment lines. Preserves
 * the right-hand side verbatim — critical for `FIREBASE_ADMIN_PRIVATE_KEY`,
 * whose quoted `\n`-escaped one-line form must survive a round-trip unmangled.
 * Only meaningful in local dev (guarded by the caller). Returns an empty map
 * when the file is absent or unreadable.
 */
export function readEnvLocalLines(): Map<string, StoredEnvLine> {
  const map = new Map<string, StoredEnvLine>();
  try {
    if (!existsSync(ENV_LOCAL_PATH)) return map;
    const text = readFileSync(ENV_LOCAL_PATH, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const m = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (!m) continue;
      const key = m[1];
      const rhs = m[2].trimEnd();
      let value = rhs;
      if (
        (rhs.startsWith('"') && rhs.endsWith('"') && rhs.length >= 2) ||
        (rhs.startsWith("'") && rhs.endsWith("'") && rhs.length >= 2)
      ) {
        value = rhs.slice(1, -1);
      }
      // Last assignment wins, matching how dotenv loaders resolve duplicates.
      map.set(key, { line: `${key}=${rhs}`, value });
    }
  } catch {
    // Unreadable file → treat as no local env.
  }
  return map;
}
