#!/usr/bin/env node
// Smoke test of the form engine's runner bundle: an invalid job must produce
// one well-formed `result` line (failed / engine_failed) and nothing else.
//
//   node scripts/form-engine-smoke.mjs local         # node docker/form-engine/dist/runner.mjs (CI)
//   node scripts/form-engine-smoke.mjs docker <tag>  # the built image, with the CRM's docker flags
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [mode, tag] = process.argv.slice(2);
const cmd =
  mode === "docker"
    ? ["docker", ["run", "--rm", "-i", "--pull", "never", "--network", "none", "--memory", "1g", "--memory-swap", "1g",
        "--pids-limit", "512", "--cpus", "1", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
        "--tmpfs", "/tmp:size=256m", "--tmpfs", "/home/pwuser:size=64m", "--user", "pwuser", tag]]
    : ["node", [`${root}docker/form-engine/dist/runner.mjs`]];
if (mode === "docker" && !/^leadstack-form-engine:[0-9.]+-[0-9a-f]{12}$/.test(tag ?? "")) {
  console.error("usage: form-engine-smoke.mjs docker <leadstack-form-engine:tag>");
  process.exit(2);
}
const run = spawnSync(cmd[0], cmd[1], { input: "this is not a job\n", encoding: "utf8", timeout: 120_000 });
const lines = (run.stdout ?? "").split("\n").filter(Boolean);
let ok = false;
try {
  const msg = JSON.parse(lines[0] ?? "");
  ok = lines.length === 1 && msg.type === "result" && msg.result?.kind === "failed" && msg.result?.code === "engine_failed";
} catch {
  ok = false;
}
if (!ok) {
  console.error("form engine smoke FAILED", { status: run.status, error: run.error?.message, stdout: run.stdout, stderr: run.stderr?.slice(-2000) });
  process.exit(1);
}
console.log(`form engine smoke ok (${mode}): ${lines[0]}`);
