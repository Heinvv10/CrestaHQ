#!/usr/bin/env node
// Builds the mystery shop's form-engine image (docker/form-engine), idempotently.
//
//   node scripts/form-engine-image.mjs [--bundle-only]
//
// 1. Bundles src/lib/prospecting/mystery-shop/form/runner-cli.ts with rolldown
//    into docker/form-engine/dist/runner.mjs (playwright-core left external).
// 2. Copies this checkout's playwright-core (pinned to @playwright/test's
//    version) beside it, so the image needs no npm install.
// 3. Tags the image leadstack-form-engine:<playwright>-<12 hex of the build
//    context's content> and writes that tag to docker/form-engine/dist/TAG —
//    the one place the app reads it from (the Next build traces it).
// 4. `docker image inspect <tag> || docker build`. Prints the tag.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

const root = fileURLToPath(new URL("..", import.meta.url));
const ctx = join(root, "docker/form-engine");
const dist = join(ctx, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  input: join(root, "src/lib/prospecting/mystery-shop/form/runner-cli.ts"),
  platform: "node",
  external: ["playwright-core"],
  resolve: {
    alias: {
      "@": join(root, "src"),
      // `server-only` throws outside a React Server build; the runner is plain Node.
      "server-only": join(root, "src/test/server-only-stub.ts"),
    },
  },
  // NODE_ENV is read at run time (the runner forces it), never inlined.
  output: { file: join(dist, "runner.mjs"), format: "esm", minify: false },
});

const pw = realpathSync(join(root, "node_modules/playwright-core"));
const version = JSON.parse(readFileSync(join(pw, "package.json"), "utf8")).version;
cpSync(pw, join(dist, "node_modules/playwright-core"), { recursive: true, dereference: true });

// The content hash of everything the image is built from (Dockerfile, seccomp profile, runner, playwright-core).
const files = (dir) =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const hash = createHash("sha256");
for (const f of files(ctx).filter((f) => !f.endsWith("/TAG")).sort()) {
  hash.update(relative(ctx, f)).update(readFileSync(f));
}
const tag = `leadstack-form-engine:${version}-${hash.digest("hex").slice(0, 12)}`;
writeFileSync(join(dist, "TAG"), `${tag}\n`);

if (!process.argv.includes("--bundle-only")) {
  const have = (() => {
    try {
      execFileSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  if (!have) execFileSync("docker", ["build", "--pull=false", "-t", tag, ctx], { stdio: "inherit" });
}
console.log(tag);
