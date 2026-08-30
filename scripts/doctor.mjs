// LeadStack preflight — environment checker.
//
// Run standalone with `pnpm doctor`. Pure Node, zero dependencies, no
// network calls — it validates the SHAPE of your .env.local so the most
// common setup mistakes surface as a readable status board instead of a
// blank page or a feature that silently never works.
//
// It does NOT gate `pnpm dev` / `pnpm build` — purely an opt-in helper.
//
// The env CATALOG + shape validators live in src/lib/setup/env-schema.mjs so
// this CLI and the in-app setup form share one source of truth. This file owns
// env-file parsing, the live Firebase checks, and the terminal report.
//
// What the statuses mean:
//   ✓ ok        configured and well-formed
//   ⚠ check     configured but a value looks off, OR partially configured
//               (some vars in the group set, some missing — usually a bug)
//   ○ off       not configured — that feature is simply disabled (fine)
//   ✗ error     a value required for the app to BOOT is missing/malformed
//
// Exit code: 1 if any ✗ error, else 0.
//
// Flags:
//   --prod   read from process.env only (Vercel/CI) instead of .env.local
//   --live   additionally connect to Firebase and verify it live

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GROUPS, evaluateGroup } from "../src/lib/setup/env-schema.mjs";

const PROD = process.argv.includes("--prod");
const LIVE = process.argv.includes("--live");
const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;

const c = {
  red: (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  yellow: (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  cyan: (s) => (NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`),
  dim: (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

// ── env loading ─────────────────────────────────────────────────────────────

/** Index of an unescaped closing quote `q` in `s`, or -1. */
function findClosingQuote(s, q) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

/**
 * Minimal .env parser: handles `export ` prefixes, # comments, single/double
 * quotes, and quoted values that span MULTIPLE physical lines (a real-newline
 * private key pasted straight in — itself a mistake we catch downstream).
 */
function parseEnvFile(text) {
  const env = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    i++;
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const work = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const eq = work.indexOf("=");
    if (eq === -1) continue;
    const key = work.slice(0, eq).trim();
    let val = work.slice(eq + 1);

    if (val.length > 0 && (val[0] === '"' || val[0] === "'")) {
      const q = val[0];
      val = val.slice(1);
      const idx = findClosingQuote(val, q);
      if (idx !== -1) {
        val = val.slice(0, idx);
      } else {
        const parts = [val];
        while (i < lines.length) {
          const l = lines[i];
          i++;
          const ci = findClosingQuote(l, q);
          if (ci !== -1) {
            parts.push(l.slice(0, ci));
            break;
          }
          parts.push(l);
        }
        val = parts.join("\n");
      }
    } else {
      const hash = val.indexOf(" #");
      if (hash !== -1) val = val.slice(0, hash);
      val = val.trim();
    }
    env[key] = val;
  }
  return env;
}

let fileEnv = {};
let source = "";
if (PROD) {
  fileEnv = { ...process.env };
  source = "process.env (--prod)";
} else {
  const path = resolve(process.cwd(), ".env.local");
  try {
    fileEnv = parseEnvFile(readFileSync(path, "utf8"));
    source = ".env.local";
  } catch {
    console.log(
      `\n${c.red("✗")} No ${c.bold(".env.local")} found in this folder.\n` +
        `   ${c.dim("Copy the template first:")}  cp .env.example .env.local\n`,
    );
    process.exit(1);
  }
}

const lookup = (k) => (fileEnv[k] !== undefined ? fileEnv[k] : process.env[k]);
const val = (k) => (lookup(k) ?? "").trim();

// ── live Firebase checks (only with --live / `pnpm doctor:firebase`) ─────────
//
// Uses the firebase-admin SDK that's already a project dependency + built-in
// fetch. Every check is independent and best-effort: it confirms what it can,
// downgrades to a skip when an API/permission isn't available, and only hard-
// fails on the unambiguous blockers (bad credentials, Firestore not created).

const firstLine = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 160);
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

async function firebaseLive() {
  const out = { errors: 0, warns: 0 };
  console.log(`\n${c.bold("Firebase — live checks")} ${c.dim("(connecting to your project…)")}`);

  const ok = (m) => console.log(`  ${c.green("✓")} ${m}`);
  const skip = (m) => console.log(`  ${c.dim("○ " + m + " — skipped")}`);
  const warn = (m, ...fix) => {
    out.warns++;
    console.log(`  ${c.yellow("⚠")} ${m}`);
    fix.forEach((f) => console.log(`      ${c.dim("→ " + f)}`));
  };
  const bad = (m, ...fix) => {
    out.errors++;
    console.log(`  ${c.red("✗")} ${m}`);
    fix.forEach((f) => console.log(`      ${c.dim("→ " + f)}`));
  };

  const projectId = val("FIREBASE_ADMIN_PROJECT_ID");
  const clientEmail = val("FIREBASE_ADMIN_CLIENT_EMAIL");
  const privateKey = val("FIREBASE_ADMIN_PRIVATE_KEY").replace(/\\n/g, "\n");
  const bucket = val("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET");

  if (!projectId || !clientEmail || !privateKey.includes("BEGIN PRIVATE KEY")) {
    warn("Skipping live checks — Admin SDK config is incomplete or malformed (fix the ✗ items above first).");
    return out;
  }

  let admin;
  try {
    admin = (await import("firebase-admin")).default;
  } catch {
    warn(
      "Live checks need dependencies installed.",
      "Run  pnpm install  then  pnpm doctor:firebase",
    );
    return out;
  }

  const cred = admin.credential.cert({ projectId, clientEmail, privateKey });
  let app;
  try {
    app = admin.initializeApp(
      { credential: cred, storageBucket: bucket || undefined },
      "doctor",
    );
  } catch (e) {
    bad(`Couldn't initialize the Admin SDK: ${firstLine(e)}`);
    return out;
  }

  // 1) Credentials — actually mint a Google access token.
  let token = null;
  try {
    const t = await withTimeout(cred.getAccessToken(), 10000, "Token");
    token = t.access_token;
    ok(`Admin credentials valid — authenticated to "${projectId}"`);
  } catch (e) {
    bad("Admin credentials rejected — couldn't authenticate to Google", firstLine(e),
      "The private key may be revoked, or belong to a different project.");
    await app.delete().catch(() => {});
    return out; // nothing downstream can work
  }

  // 2) Firestore reachable / database exists.
  try {
    await withTimeout(admin.firestore(app).listCollections(), 12000, "Firestore");
    ok("Firestore database reachable");
  } catch (e) {
    const m = firstLine(e);
    if (/NOT_FOUND|does not exist|5 NOT_FOUND/i.test(m))
      bad("Firestore database not created",
        "Firebase Console → Firestore Database → Create database (Production mode).");
    else if (/PERMISSION_DENIED|7 PERMISSION_DENIED/i.test(m))
      warn("Firestore reachable but the service account was denied",
        "Confirm the service account keeps its default Editor / Firestore access.");
    else warn(`Firestore check inconclusive: ${m}`);
  }

  // 3) Storage bucket exists.
  if (bucket) {
    try {
      const [exists] = await withTimeout(
        admin.storage(app).bucket().exists(),
        10000,
        "Storage",
      );
      if (exists) ok(`Storage bucket "${bucket}" exists`);
      else
        warn(`Storage bucket "${bucket}" not found`,
          "Firebase Console → Storage → Get started, or fix NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET.");
    } catch (e) {
      warn(`Storage check inconclusive: ${firstLine(e)}`);
    }
  } else {
    skip("Storage (no bucket configured)");
  }

  // 4) Authentication reachable + Email/Password provider enabled.
  try {
    await withTimeout(admin.auth(app).listUsers(1), 10000, "Auth");
    ok("Authentication reachable");
  } catch (e) {
    warn(`Authentication check inconclusive: ${firstLine(e)}`,
      "If it says the Identity Toolkit API is disabled, open Authentication in the console to enable it.");
  }
  try {
    const res = await withTimeout(
      fetch(
        `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      10000,
      "Auth config",
    );
    if (res.ok) {
      const cfg = await res.json();
      if (cfg?.signIn?.email?.enabled === true)
        ok("Email/Password sign-in is ENABLED");
      else
        warn("Email/Password sign-in appears DISABLED",
          "Firebase Console → Authentication → Sign-in method → enable Email/Password.");
    } else {
      skip(`Email/Password provider check (config API returned ${res.status})`);
    }
  } catch (e) {
    skip(`Email/Password provider check (${firstLine(e)})`);
  }

  // 5) Firestore security rules published.
  try {
    const res = await withTimeout(
      fetch(
        `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      10000,
      "Rules",
    );
    if (res.ok) {
      const data = await res.json();
      const hasFs = (data.releases || []).some((r) =>
        /cloud\.firestore/i.test(r.name || ""),
      );
      if (hasFs) ok("Firestore security rules are published");
      else
        warn("No published Firestore rules found",
          "Run  firebase deploy --only firestore:rules,firestore:indexes");
    } else {
      skip(`Rules check (rules API returned ${res.status})`);
    }
  } catch (e) {
    skip(`Rules check (${firstLine(e)})`);
  }

  await app.delete().catch(() => {});
  return out;
}

// ── report ──────────────────────────────────────────────────────────────────

let errorCount = 0;
let warnCount = 0;

const glyph = {
  ok: c.green("✓"),
  check: c.yellow("⚠"),
  off: c.dim("○"),
  error: c.red("✗"),
};

function line(g, r) {
  let tail = "";
  if (r.status === "off") tail = c.dim(`— ${g.off ?? "not configured"}`);
  else if (g.tier !== "boot" && r.reqTotal > 0)
    tail = c.dim(`(${r.reqPresent}/${r.reqTotal})`);
  console.log(`  ${glyph[r.status]} ${g.title}  ${tail}`);

  if (r.missingReq.length && r.status === "check")
    console.log(`      ${c.dim("→ partial — missing: " + r.missingReq.join(", "))}`);
  if (r.status === "error" && r.missingReq.length)
    console.log(`      ${c.dim("→ missing: " + r.missingReq.join(", "))}`);
  if (r.missingRec.length && r.status !== "off")
    console.log(`      ${c.dim("→ recommended: " + r.missingRec.join(", "))}`);
  for (const n of r.notes) {
    if (n.level === "error" || n.level === "warn")
      console.log(`      ${c.dim("→ " + n.msg)}`);
  }
}

console.log(`\n${c.bold("🔎 LeadStack preflight")} ${c.dim(`— ${source}`)}`);

console.log(`\n${c.bold("Required to run")}`);
for (const g of GROUPS.filter((x) => x.tier === "boot")) {
  const r = evaluateGroup(g, lookup);
  if (r.status === "error") errorCount += Math.max(1, r.missingReq.length);
  if (r.status === "check") warnCount++;
  line(g, r);
}

console.log(
  `\n${c.bold("Setup form")} ${c.dim("(optional — enables the in-app env setup form)")}`,
);
for (const g of GROUPS.filter((x) => x.tier === "preflight")) {
  const r = evaluateGroup(g, lookup);
  if (r.status === "check") warnCount++;
  line(g, r);
}

console.log(`\n${c.bold("Features")} ${c.dim("(○ = off is fine — turn on when you need it)")}`);
let configured = 0;
let available = 0;
// Skip variant-scoped groups (e.g. the LeadStack founders offset) — they're
// demo-only and not part of a buyer's generic setup. They stay in the `known`
// set below so their keys aren't flagged as unrecognized.
for (const g of GROUPS.filter((x) => x.tier === "feature" && !x.variant)) {
  const r = evaluateGroup(g, lookup);
  if (r.status === "ok") configured++;
  if (r.status === "off") available++;
  if (r.status === "check") warnCount++;
  line(g, r);
}

// Unrecognized keys (likely typos) — only meaningful when reading a file.
if (!PROD) {
  const known = new Set(GROUPS.flatMap((g) => g.vars.map((v) => v[0])));
  // Optional / advanced vars the app reads but that aren't in .env.example.
  for (const k of [
    "GITPAGE_TELEMETRY",
    "NEXT_PUBLIC_FOUNDERS_MANUAL_SOLD",
    "GITPAGE_STRIPE_SECRET_KEY",
    "LANDING_SEED_PURCHASES",
    "OUTBOUND_COMPLIANCE_PROVIDER",
    "GITHUB_TEMPLATE_REPO_URL",
    // Platform-injected — never set by hand, but harmless if present.
    "NODE_ENV",
    "NEXT_RUNTIME",
    "VERCEL",
    "RENDER",
    "RAILWAY_PROJECT_ID",
    "FLY_APP_NAME",
    "NO_COLOR",
  ])
    known.add(k);
  const unknown = Object.keys(fileEnv).filter((k) => !known.has(k));
  if (unknown.length) {
    console.log(`\n${c.bold("Unrecognized keys")} ${c.dim("(typo, or your own additions)")}`);
    for (const k of unknown) console.log(`  ${c.cyan("?")} ${k}`);
  }
}

// ── live Firebase checks (opt-in) ───────────────────────────────────────────

if (LIVE) {
  const live = await firebaseLive();
  errorCount += live.errors;
  warnCount += live.warns;
} else {
  console.log(
    c.dim(
      `\n  Tip: run ${c.bold("pnpm doctor:firebase")} to verify the live Firebase` +
        ` connection\n       (auth provider, Firestore, Storage, rules).`,
    ),
  );
}

// ── summary ─────────────────────────────────────────────────────────────────

console.log("");
const parts = [];
parts.push(errorCount ? c.red(`${errorCount} error(s)`) : c.green("0 errors"));
if (warnCount) parts.push(c.yellow(`${warnCount} to check`));
parts.push(c.dim(`${configured} feature(s) on, ${available} available`));
console.log("  " + parts.join(c.dim(" · ")));

if (errorCount) {
  console.log(c.red("\n  Fix the ✗ items above before the app will boot.\n"));
  process.exit(1);
}
console.log(c.dim("\n  No blockers. ○ items are optional features you can enable anytime.\n"));
process.exit(0);
