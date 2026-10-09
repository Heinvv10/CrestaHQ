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
//    context's content>; `docker image inspect <tag> || docker build`.
// 4. Creates the engine's own network if missing: `leadstack-form`, bridge,
//    subnet 172.16.88.0/24, inter-container traffic off. Host firewalling of
//    that subnet is scripts/form-engine-firewall.sh (root, run once by hand).
// 5. Only once the image AND the network exist: writes the tag to
//    docker/form-engine/dist/TAG — the one place the app reads it from (the
//    Next build traces it). Prints the tag.
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
const NETWORK = "leadstack-form";
const SUBNET = "172.16.88.0/24";
const ok = (args) => {
  try {
    execFileSync("docker", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!process.argv.includes("--bundle-only")) {
  if (!ok(["image", "inspect", tag])) execFileSync("docker", ["build", "--pull=false", "-t", tag, ctx], { stdio: "inherit" });
  if (!ok(["network", "inspect", NETWORK])) {
    execFileSync("docker", [
      "network", "create", "--driver", "bridge", "--subnet", SUBNET, "--gateway", "172.16.88.1",
      "-o", "com.docker.network.bridge.enable_icc=false", "-o", "com.docker.network.bridge.name=br-lsms-form", NETWORK,
    ], { stdio: "inherit" });
  }
  // An existing network must be the one this expects (the firewall script matches its subnet and bridge).
  const info = JSON.parse(execFileSync("docker", ["network", "inspect", NETWORK], { encoding: "utf8" }))[0];
  const subnet = info?.IPAM?.Config?.[0]?.Subnet;
  const icc = info?.Options?.["com.docker.network.bridge.enable_icc"];
  if (subnet !== SUBNET || icc !== "false") {
    throw new Error(`docker network ${NETWORK} exists with subnet ${subnet} and icc=${icc}; expected ${SUBNET}, icc=false`);
  }
  // Only now: the release's app reads this tag, so it must name an image (and network) that exist.
  writeFileSync(join(dist, "TAG"), `${tag}\n`);
}
console.log(tag);
