#!/usr/bin/env node
/**
 * FROZEN only shrinks (AGENCY_AGENT_API_PLAN.md, PR A1).
 *
 * scripts/agent-coverage-frozen.json lists the routes that had no agent tool
 * when the coverage gate landed. A new route must get tool(s) or a written
 * exclusion, never a FROZEN line, so a pull request may delete keys from it
 * and may never add one. This compares the PR's list with the base branch's.
 *
 * Where it runs: the CI workflow, on `pull_request`, after fetching the base
 * branch into refs/remotes/origin/<base>. On a pull_request event it FAILS
 * CLOSED: no GITHUB_BASE_REF, or no fetched base ref, is an error, never a
 * pass. Outside a pull_request event (push to main, scripts/deploy-velo.sh,
 * a local run, a buyer's generated repo) there is no base to compare with,
 * so it says so and exits 0; check-agent-coverage.mjs still runs there.
 * When the base branch has no FROZEN file yet, the PR is the one introducing
 * the gate and passes.
 *
 * What it does not buy: `pull_request` runs the workflow and this script
 * from the PR's own head, so a PR that edits either can switch the check
 * off. That edit shows in the diff, and review refuses it.
 *
 * Usage: node scripts/check-agent-coverage-shrink.mjs [repo-root]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FROZEN_PATH = "scripts/agent-coverage-frozen.json";

/** Keys in `head` that `base` does not have. */
export function addedKeys(base, head) {
  const before = new Set(base);
  return [...new Set(head)].filter((k) => !before.has(k));
}

function fail(message) {
  console.error(`\nFROZEN shrink check: ${message}\n`);
  process.exit(1);
}

const isEntrypoint =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  if (process.env.GITHUB_EVENT_NAME !== "pull_request") {
    console.log("FROZEN shrink check: skipped, not a pull_request event (no base branch to compare with)");
    process.exit(0);
  }
  const baseRef = process.env.GITHUB_BASE_REF;
  if (!baseRef) fail("GITHUB_BASE_REF is not set on a pull_request event — refusing to pass without a base.");
  const ref = `refs/remotes/origin/${baseRef}`;
  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    fail(`${ref} is missing — fetch the base branch before this step (see .github/workflows/ci.yml).`);
  }

  if (git("ls-tree", "--name-only", ref, "--", FROZEN_PATH).trim() === "") {
    console.log(`FROZEN shrink check: ${baseRef} has no ${FROZEN_PATH} yet — this PR introduces the gate`);
    process.exit(0);
  }
  const baseText = git("show", `${ref}:${FROZEN_PATH}`);
  const head = JSON.parse(readFileSync(join(root, FROZEN_PATH), "utf8"));
  const added = addedKeys(JSON.parse(baseText), head);
  if (added.length > 0) {
    fail(
      `these keys were ADDED to ${FROZEN_PATH}; FROZEN only shrinks. Give each route agent tool(s) or a written exclusion in scripts/agent-coverage.json instead:\n` +
        added.map((k) => `  ${k}`).join("\n"),
    );
  }
  console.log(`FROZEN shrink check: no key added against ${baseRef} (${head.length} keys)`);
}
