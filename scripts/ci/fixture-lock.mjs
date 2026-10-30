#!/usr/bin/env node
// CLI for the E2E fixture lock; the lock itself is in fixture-lock-core.mjs.
//
//   node scripts/ci/fixture-lock.mjs acquire   # waits; never cancels anyone
//   node scripts/ci/fixture-lock.mjs release   # deletes the ref only if ours

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Superseded, acquire, check, release } from "./fixture-lock-core.mjs";

/** One GitHub REST call. Returns { status, body }; never throws. */
export function githubApi({ token, repo, apiUrl = "https://api.github.com" }) {
  return async (method, path, body) => {
    let res;
    try {
      res = await fetch(`${apiUrl}/repos/${repo}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // A dropped connection is retried like a 5xx (see check()).
      return { status: 599, body: { error: String(err) } };
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  };
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const env = process.env;
  for (const k of [
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ]) {
    if (!env[k]) throw new Error(`${k} is not set`);
  }
  const api = githubApi({
    token: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    apiUrl: env.GITHUB_API_URL,
  });
  const holder = {
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    workflow: env.GITHUB_WORKFLOW ?? "?",
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (cmd === "acquire") {
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      encoding: "utf8",
    }).trim();
    // On a PR, stop waiting once a newer push (or closing the PR) makes this
    // run pointless; the newer head's own run takes its place in the queue.
    const pr = env.LOCK_PR_NUMBER;
    const superseded = pr
      ? async () => {
          const res = check(await api("GET", `/pulls/${pr}`), [200], "read PR");
          if (res.body.state !== "open")
            return `PR #${pr} is ${res.body.state}`;
          if (res.body.head.sha !== env.LOCK_PR_HEAD_SHA)
            return `PR #${pr} has a newer head ${res.body.head.sha}`;
          return null;
        }
      : undefined;
    await acquire(api, { tree, holder, sleep, superseded });
  } else if (cmd === "release") {
    await release(api, { holder, sleep });
  } else {
    throw new Error("usage: fixture-lock.mjs acquire|release");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    const superseded = err instanceof Superseded;
    console.error(
      superseded
        ? `superseded, not running E2E for this commit: ${err.message}`
        : err.message
    );
    process.exit(1);
  });
}
