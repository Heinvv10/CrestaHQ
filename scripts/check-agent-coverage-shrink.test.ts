import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addedKeys } from "./check-agent-coverage-shrink.mjs";

/**
 * Runs the shrink check against a throwaway git repo: a base commit is
 * published as refs/remotes/origin/main (what CI's fetch step produces), then
 * the working tree's FROZEN list is edited. The GITHUB_* variables are set
 * per case, never inherited, so the suite behaves the same inside CI.
 */

const SCRIPT = path.join(__dirname, "check-agent-coverage-shrink.mjs");
const FROZEN = "scripts/agent-coverage-frozen.json";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(base: string[] | null, head: string[], mainRef = "refs/remotes/origin/main"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-coverage-shrink-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "pipe" });
  git("init", "-q");
  fs.mkdirSync(path.join(dir, "scripts"));
  if (base) fs.writeFileSync(path.join(dir, FROZEN), JSON.stringify(base));
  else fs.writeFileSync(path.join(dir, "README"), "base without FROZEN");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("update-ref", mainRef, "HEAD");
  fs.writeFileSync(path.join(dir, FROZEN), JSON.stringify(head));
  return dir;
}

function run(dir: string, env: Record<string, string>) {
  const full = { ...process.env };
  for (const k of Object.keys(full)) if (k.startsWith("GITHUB_")) delete full[k];
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", env: { ...full, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const PR = { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" };

describe("check-agent-coverage-shrink CLI", () => {
  it("fails a pull request that adds a FROZEN key, naming it", () => {
    const r = run(repo(["a:GET", "b:POST"], ["a:GET", "b:POST", "c:PATCH"]), PR);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ADDED");
    expect(r.stderr).toContain("  c:PATCH");
  });

  it("fails a key swapped in for a removed one", () => {
    const r = run(repo(["a:GET", "b:POST"], ["a:GET", "c:PATCH"]), PR);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("  c:PATCH");
  });

  it("passes a pull request that only removes keys", () => {
    const r = run(repo(["a:GET", "b:POST"], ["a:GET"]), PR);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no key added against main");
  });

  it("fails closed when main was never fetched", () => {
    const r = run(repo(["a:GET"], ["a:GET"], "refs/remotes/origin/release"), { ...PR, GITHUB_BASE_REF: "release" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refs/remotes/origin/main is missing");
  });

  it("compares against main even when the PR targets a pre-gate branch", () => {
    const dir = repo(["a:GET"], ["a:GET", "c:PATCH"]);
    // A branch cut before the gate: an empty tree, no FROZEN file at all.
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { input, encoding: "utf8" }).trim();
    const preGate = git(["commit-tree", "-m", "pre-gate", git(["mktree"], "")]);
    git(["update-ref", "refs/remotes/origin/pre-gate", preGate]);
    const r = run(dir, { ...PR, GITHUB_BASE_REF: "pre-gate" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("  c:PATCH");
  });

  it("passes the PR that introduces the gate (base has no FROZEN file)", () => {
    const r = run(repo(null, ["a:GET"]), PR);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("this PR introduces the gate");
  });

  it("skips outside a pull_request event, even with keys added", () => {
    const r = run(repo(["a:GET"], ["a:GET", "c:PATCH"]), { GITHUB_EVENT_NAME: "push" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("skipped, not a pull_request event");
  });

  it("is wired into its own workflow exactly, with no off-switch", () => {
    // Every non-comment line is pinned, so a `paths:` / `branches:` filter, a
    // changed or added `if:`, a concurrency group, an event skip or an
    // `|| true` on the fetch or the script all fail here. A cancelled or
    // skipped run would be the check's latest result and hide a failure.
    const wf = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "agent-coverage-shrink.yml"), "utf8");
    const lines = wf.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(lines).toEqual([
      "name: Agent coverage FROZEN shrink",
      "on:",
      "  pull_request:",
      "    types: [opened, synchronize, reopened, edited]",
      "jobs:",
      "  shrink:",
      "    name: Agent coverage FROZEN only shrinks",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 5",
      "    if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}",
      "    steps:",
      "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
      "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
      "        with:",
      "          node-version-file: .nvmrc",
      "      - name: FROZEN only shrinks",
      "        run: |",
      '          git fetch --no-tags --depth=1 origin "+refs/heads/main:refs/remotes/origin/main"',
      "          node scripts/check-agent-coverage-shrink.mjs",
    ]);
  });

  it("keeps edited out of ci.yml so a body edit does not enqueue redundant gates", () => {
    const ci = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).not.toMatch(/types:.*edited/);
  });

  it("cancels fast work and replaces pending E2E when a ready PR returns to draft", () => {
    const ci = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]");
    expect(ci).not.toMatch(/^concurrency:/m);
    expect(ci).toContain("cancel_ci_on_draft:");
    expect(ci).toContain("cancel_secrets_on_draft:");
    expect(ci).toContain("replace_pending_e2e_on_draft:");
    expect(ci).toContain("group: ci-fast-${{ github.ref }}");
    expect(ci).toContain("group: ci-secrets-${{ github.ref }}");
    expect(ci).toContain("group: ci-e2e-${{ github.ref }}");
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("protects active E2E teardown and gives every main push unique groups", () => {
    const ci = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
    const unique = "${{ github.event_name == 'pull_request' && github.ref || github.run_id }}";
    expect(ci).toContain(`group: ci-fast-${unique}`);
    expect(ci).toContain(`group: ci-secrets-${unique}`);
    expect(ci).toContain(`group: ci-e2e-${unique}`);
    const draftHelper = ci.slice(ci.indexOf("\n  replace_pending_e2e_on_draft:"), ci.indexOf("\n  ci:"));
    expect(draftHelper).toMatch(/group: ci-e2e-.*\n\s+cancel-in-progress: false/);
    const e2e = ci.slice(ci.indexOf("\n  e2e:\n"));
    expect(e2e).toMatch(/group: ci-e2e-.*\n\s+cancel-in-progress: false/);
  });

  it("keeps E2E and the production smoke on the one self-hosted fixture runner, everything else hosted", () => {
    const wf = (f: string) => fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", f), "utf8");
    const e2eLabel = "runs-on: [self-hosted, linux, velo, crestahq, crestahq-e2e]";
    const ci = wf("ci.yml");
    const e2e = ci.slice(ci.indexOf("\n  e2e:\n"));
    const hosted = ci.slice(ci.indexOf("\n  ci:\n"), ci.indexOf("\n  e2e:\n"));
    expect(e2e).toContain(e2eLabel);
    expect(hosted.match(/runs-on: ubuntu-latest/g)).toHaveLength(2);
    // The draft helpers run before `ci:`; all three are hosted, and the one that
    // shares E2E's concurrency group must carry the same-repo fork guard.
    const helpers = ci.slice(ci.indexOf("\njobs:\n"), ci.indexOf("\n  ci:\n"));
    expect(helpers.match(/runs-on: ubuntu-latest/g)).toHaveLength(3);
    expect(helpers).not.toContain("runs-on: [self-hosted");
    const e2eHelper = helpers.slice(helpers.indexOf("\n  replace_pending_e2e_on_draft:"));
    expect(e2eHelper).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(hosted).not.toContain("runs-on: [self-hosted");
    // The self-hosted runner has no sudo, so --with-deps (an apt step) must stay off these jobs.
    expect(e2e).not.toMatch(/install --with-deps/);
    expect(wf("e2e-smoke.yml")).not.toMatch(/install --with-deps/);
    expect(wf("e2e-smoke.yml")).toContain(e2eLabel);
    for (const f of ["wa-manager.yml", "wa-agent-bridge.yml", "agent-coverage-shrink.yml"]) {
      expect(wf(f)).toContain("runs-on: ubuntu-latest");
      expect(wf(f)).not.toContain("self-hosted,");
    }
  });
});

describe("addedKeys", () => {
  it("returns head keys the base lacks, once each", () => {
    expect(addedKeys(["a", "b"], ["b", "c", "c", "d"])).toEqual(["c", "d"]);
    expect(addedKeys(["a", "b"], ["a"])).toEqual([]);
  });
});
