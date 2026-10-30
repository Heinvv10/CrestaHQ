#!/usr/bin/env node
// Cross-run mutex for the E2E fixture tenants, held as a git ref.
//
//   node scripts/ci/fixture-lock.mjs acquire   # waits; never cancels anyone
//   node scripts/ci/fixture-lock.mjs release   # deletes the ref only if ours
//
// Every Playwright run (ci.yml E2E, e2e-smoke.yml) seeds and purges the SAME
// fixture sub-accounts in the production Firestore, so two runs must never
// overlap. A GitHub concurrency group cannot serialise them: it keeps one
// pending run per group and cancels the rest, which would cancel other PRs'
// required check. This lock waits instead.
//
// The lock is refs/ci-locks/e2e-fixtures, pointing at an orphan commit whose
// message records the holder (run id + attempt) and whose committer date is
// GitHub's own clock. Two git-ref operations are atomic on GitHub's side:
//   - create fails with 422 if the ref exists        -> acquire when free
//   - update with force:false fails unless the new
//     commit descends from the current one         -> steal a stale lock
// A stale lock is stolen by committing ON TOP of it, so two waiters that both
// judge the same lock stale cannot both win: the second one's commit no longer
// descends from the ref. Stale = the holder's run attempt has completed (or is
// gone), or the lock is older than STALE_MS — longer than any holder can live,
// because the Playwright step's own timeout bounds how long it is held.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const LOCK_REF = "ci-locks/e2e-fixtures";
export const STALE_MS = 90 * 60_000;
export const POLL_MS = 20_000;

/** One GitHub REST call. Returns { status, body }; never throws on HTTP status. */
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

function check(res, ok, what) {
  if (ok.includes(res.status)) return res;
  const err = new Error(
    `${what}: HTTP ${res.status} ${JSON.stringify(res.body)}`
  );
  // 5xx and rate limits are worth another poll; anything else is a real fault
  // (wrong permissions, bad request) and must fail the step, not spin.
  err.transient = res.status >= 500 || res.status === 429;
  throw err;
}

async function newLockCommit(api, { tree, holder, parent }) {
  const res = check(
    await api("POST", "/git/commits", {
      message: JSON.stringify(holder),
      tree,
      parents: parent ? [parent] : [],
    }),
    [201],
    "create lock commit"
  );
  return res.body.sha;
}

/** Whether the lock commit's holder can no longer be using the fixtures. */
async function isStale(api, sha, now) {
  const commit = check(
    await api("GET", `/git/commits/${sha}`),
    [200],
    "read lock commit"
  ).body;
  const age = now() - Date.parse(commit.committer.date);
  if (age > STALE_MS)
    return { stale: true, why: `held ${Math.round(age / 60_000)} min` };
  let holder;
  try {
    holder = JSON.parse(commit.message);
  } catch {
    return {
      stale: false,
      why: "unrecognised holder; waiting for the age limit",
    };
  }
  const run = await api(
    "GET",
    `/actions/runs/${holder.runId}/attempts/${holder.attempt}`
  );
  if (run.status === 404)
    return { stale: true, why: `holder run ${holder.runId} is gone` };
  check(run, [200], "read holder run");
  if (run.body.status === "completed") {
    return {
      stale: true,
      why: `holder run ${holder.runId}#${holder.attempt} completed without releasing`,
    };
  }
  return {
    stale: false,
    why: `held by ${holder.workflow} run ${holder.runId}#${holder.attempt} (${run.body.html_url})`,
  };
}

/** Blocks until this run holds the lock. Returns the lock commit sha. */
export async function acquire(
  api,
  { tree, holder, now = Date.now, sleep, log = console.error }
) {
  for (;;) {
    try {
      const current = await api("GET", `/git/ref/${LOCK_REF}`);
      if (current.status === 404) {
        // Free. The commit is made only now, so its date is the acquire time.
        const mine = await newLockCommit(api, { tree, holder });
        const created = await api("POST", "/git/refs", {
          ref: `refs/${LOCK_REF}`,
          sha: mine,
        });
        if (created.status === 201) {
          log(`fixture lock acquired (${mine})`);
          return mine;
        }
        check(created, [422], "create lock ref");
        log("another run created the fixture lock first; waiting");
      } else {
        const heldSha = check(current, [200], "read lock ref").body.object.sha;
        const { stale, why } = await isStale(api, heldSha, now);
        if (stale) {
          const steal = await newLockCommit(api, {
            tree,
            holder,
            parent: heldSha,
          });
          const moved = await api("PATCH", `/git/refs/${LOCK_REF}`, {
            sha: steal,
            force: false,
          });
          if (moved.status === 200) {
            log(
              `fixture lock taken over from a stale holder: ${why} (${steal})`
            );
            return steal;
          }
          // 422: another run moved or deleted it first (not a fast-forward any more).
          check(moved, [422], "steal lock ref");
          log("a stale fixture lock was taken by another run first; waiting");
        } else {
          log(`waiting for the fixture lock: ${why}`);
        }
      }
    } catch (err) {
      if (!err.transient) throw err;
      log(`GitHub API hiccup, will retry: ${err.message}`);
    }
    await sleep(POLL_MS);
  }
}

/** Deletes the lock only if it is still ours; a no-op otherwise. */
export async function release(api, { mine, log = console.error }) {
  if (!mine) {
    log("fixture lock was never acquired by this job; nothing to release");
    return false;
  }
  const current = await api("GET", `/git/ref/${LOCK_REF}`);
  if (current.status === 404) {
    log("fixture lock already gone");
    return false;
  }
  const heldSha = check(current, [200], "read lock ref").body.object.sha;
  if (heldSha !== mine) {
    log(`fixture lock is held by another run (${heldSha}); not touching it`);
    return false;
  }
  check(await api("DELETE", `/git/refs/${LOCK_REF}`), [204], "delete lock ref");
  log("fixture lock released");
  return true;
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
  if (cmd === "acquire") {
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      encoding: "utf8",
    }).trim();
    const holder = {
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      workflow: env.GITHUB_WORKFLOW ?? "?",
    };
    const mine = await acquire(api, {
      tree,
      holder,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    // The release step reads this back; it runs even when the job is cancelled.
    if (env.GITHUB_ENV)
      fs.appendFileSync(env.GITHUB_ENV, `FIXTURE_LOCK_SHA=${mine}\n`);
  } else if (cmd === "release") {
    await release(api, { mine: env.FIXTURE_LOCK_SHA });
  } else {
    throw new Error("usage: fixture-lock.mjs acquire|release");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
