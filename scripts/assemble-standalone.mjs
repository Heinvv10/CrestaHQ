#!/usr/bin/env node
/**
 * Completes `.next/standalone` after `next build` so it can run on its own.
 * Used by BOTH scripts/deploy-velo.sh and `pnpm e2e:server`, so the E2E gate
 * boots the same bundle production does.
 *
 * Next's standalone output leaves out three things:
 *  - `.next/static` and `public` (documented; always copied in by hand);
 *  - `.next/server/instrumentation.js` and chunks only it uses (Next 15.5 +
 *    Turbopack). Without it the server starts fine and simply never calls
 *    instrumentation.ts `register()` — no API-key log redaction, no QStash
 *    schedules, no heartbeat. That shipped unnoticed, so this script copies
 *    the file plus every file its trace lists, then fails if it is absent.
 *
 * Run from the project root, after `next build`.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next/standalone");
const serverDir = path.join(root, ".next/server");

function die(message) {
  console.error(`assemble-standalone: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(standalone, "server.js"))) {
  die("standalone server.js missing — is output:'standalone' still set in next.config.ts?");
}

for (const dir of [".next/static", "public"]) {
  const dest = path.join(standalone, dir);
  fs.rmSync(dest, { recursive: true, force: true });
  if (fs.existsSync(path.join(root, dir))) {
    fs.cpSync(path.join(root, dir), dest, { recursive: true });
  }
}

const hook = path.join(serverDir, "instrumentation.js");
if (!fs.existsSync(hook)) die(".next/server/instrumentation.js missing — did `next build` run?");

const traced = JSON.parse(fs.readFileSync(`${hook}.nft.json`, "utf8")).files;
let copied = 0;
for (const file of [hook, ...traced.map((f) => path.resolve(serverDir, f))]) {
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) die(`traced file outside the project: ${file}`);
  const dest = path.join(standalone, rel);
  // Never overwrite: node_modules in the bundle are Next's own traced copies.
  if (fs.existsSync(dest)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // pnpm's node_modules is relative symlinks: recreate the link text as-is,
  // as Next's own trace copy does, so the bundle stays self-contained.
  if (fs.lstatSync(file).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(file), dest);
  else fs.copyFileSync(file, dest);
  copied++;
}

if (!fs.existsSync(path.join(standalone, ".next/server/instrumentation.js"))) {
  die("instrumentation.js is still missing from the standalone bundle");
}
console.log(`assemble-standalone: static + public copied; instrumentation added (${copied} files)`);
