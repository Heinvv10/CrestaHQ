#!/usr/bin/env node
// Builds the mystery shop's form-engine image (docker/form-engine), idempotently.
//
//   node scripts/form-engine-image.mjs [--bundle-only] [--keep]
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
// 5. Smoke-runs the image (an invalid job must answer one result line).
// 6. --keep (the deploy): runs an idle keeper container for this tag on the
//    network. Dokploy's nightly `docker system prune --all` (02:00 SAST)
//    deletes every image and network no container uses — between jobs, the
//    engine's. One keeper per tag, so the live release's stays until the
//    deploy has switched; the deploy then removes keepers no release names
//    (prune_form_keepers in deploy-velo-bluegreen.sh).
// 7. Only once the image, the network and the smoke pass: writes the tag to
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

// The content hash of everything the image is built from (Dockerfile, runner, playwright-core).
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
  const bridge = info?.Options?.["com.docker.network.bridge.name"];
  if (subnet !== SUBNET || icc !== "false" || bridge !== "br-lsms-form") {
    throw new Error(`docker network ${NETWORK} exists with subnet ${subnet}, icc=${icc}, bridge ${bridge}; expected ${SUBNET}, icc=false, br-lsms-form`);
  }
  // The image answers like a runner: an invalid job → one well-formed result line.
  execFileSync("node", [join(root, "scripts/form-engine-smoke.mjs"), "docker", tag], { stdio: "inherit" });
  if (process.argv.includes("--keep")) {
    const keeper = `leadstack-form-keeper-${tag.split(":")[1]}`;
    const quiet = { stdio: ["ignore", "ignore", "inherit"] };
    const inspect = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
    // Not fatal: without a keeper the engine still works until the nightly prune.
    try {
      // Reuse an existing keeper only if it holds this tag's image (a re-tag would leave it on the old one).
      const reuse = ok(["container", "inspect", keeper])
        && inspect(["container", "inspect", "-f", "{{.Image}}", keeper]) === inspect(["image", "inspect", "-f", "{{.Id}}", tag]);
      // `docker start` is a no-op on a running container and revives a stopped one.
      if (reuse) execFileSync("docker", ["start", keeper], quiet);
      else {
        if (ok(["container", "inspect", keeper])) execFileSync("docker", ["rm", "-f", keeper], quiet);
        execFileSync("docker", [
          "run", "-d", "--name", keeper, "--label", "leadstack.form-keeper=1", "--restart", "unless-stopped",
          "--pull", "never", "--network", NETWORK, "--memory", "32m", "--pids-limit", "8", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges", "--read-only", "--user", "pwuser", "--entrypoint", "sleep", tag, "infinity",
        ], quiet);
      }
    } catch {
      console.error(`WARNING: form keeper not running — the nightly prune will delete ${tag}`);
    }
  }
  // Only now: the release's app reads this tag, so it must name an image (and network) that exist.
  writeFileSync(join(dist, "TAG"), `${tag}\n`);
}
console.log(tag);
