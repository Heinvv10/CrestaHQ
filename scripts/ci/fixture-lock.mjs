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
//     commit descends from the current one         -> take over a stale lock
// A stale lock is taken over by committing ON TOP of it, so two waiters that
// both judge the same lock stale cannot both win: the second one's commit no
// longer descends from the ref. Stale = the holder's run attempt has completed
// (or is gone), or the lock is older than STALE_MS — longer than any holder
// can live, because the Playwright step's own timeout bounds how long it is
// held. Ownership is the holder recorded in the ref's commit, not a sha kept
// by the job, so a lost API response or a cancel mid-acquire cannot leave
// this run unable to recognise (and release) its own lock.
//
// GITHUB_TOKEN allows ~1,000 API calls per hour per repository, shared by
// every waiter, so a waiter polls once a minute, reads a holder's commit once
// per holder, and checks the holder run / its own PR only every DEEP_EVERY
// polls (~85 calls per waiter-hour).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LOCK_REF = "ci-locks/e2e-fixtures";
export const STALE_MS = 90 * 60_000;
export const POLL_MS = 60_000;
export const DEEP_EVERY = 5;

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

const rateLimited = (res) =>
  res.status === 429 ||
  (res.status === 403 && /rate limit/i.test(JSON.stringify(res.body)));

function check(res, ok, what) {
  if (ok.includes(res.status)) return res;
  const err = new Error(
    `${what}: HTTP ${res.status} ${JSON.stringify(res.body)}`
  );
  // 5xx, dropped connections and rate limits are worth another poll; anything
  // else is a real fault (wrong permissions, bad request) and must fail the
  // step, not spin.
  err.transient = res.status >= 500 || rateLimited(res);
  throw err;
}

const sameHolder = (a, b) =>
  !!a &&
  !!b &&
  String(a.runId) === String(b.runId) &&
  String(a.attempt) === String(b.attempt);

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

/** The holder recorded in a lock commit (null if unparseable) and its date. */
async function readLock(api, sha) {
  const c = check(
    await api("GET", `/git/commits/${sha}`),
    [200],
    "read lock commit"
  ).body;
  let holder = null;
  try {
    holder = JSON.parse(c.message);
  } catch {
    // Not written by this script; only the age limit can free it.
  }
  return { sha, holder, date: Date.parse(c.committer.date) };
}

/** Why the holder can no longer be using the fixtures, or null if it may be. */
async function holderRunEnded(api, holder) {
  const run = await api(
    "GET",
    `/actions/runs/${holder.runId}/attempts/${holder.attempt}`
  );
  if (run.status === 404) return `holder run ${holder.runId} is gone`;
  check(run, [200], "read holder run");
  if (run.body.status === "completed") {
    return `holder run ${holder.runId}#${holder.attempt} completed without releasing`;
  }
  return null;
}

export class Superseded extends Error {}

/**
 * Blocks until this run holds the lock. Returns the lock commit sha.
 * `superseded` (optional) is checked while waiting; when it returns a reason,
 * the wait ends with a Superseded error instead of testing a stale commit.
 *
 * @param {(method: string, path: string, body?: any) => Promise<{ status: number, body: any }>} api
 * @param {{ tree: string, holder: { runId: string, attempt: string, workflow: string },
 *   now?: () => number, sleep: (ms: number) => Promise<unknown>,
 *   superseded?: () => Promise<string | null>, log?: (msg: string) => void }} opts
 */
export async function acquire(
  api,
  {
    tree,
    holder,
    now = Date.now,
    sleep,
    superseded,
    log = console.error,
  }
) {
  let held = null; // readLock() of the current holder, cached per sha
  for (let poll = 0; ; poll++) {
    const deep = poll % DEEP_EVERY === 0;
    try {
      if (deep && superseded) {
        const why = await superseded();
        if (why) throw new Superseded(why);
      }
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
        if (!/already exists/i.test(JSON.stringify(created.body))) {
          throw new Error(
            `create lock ref: HTTP 422 ${JSON.stringify(created.body)}`
          );
        }
        log("another run created the fixture lock first; waiting");
      } else {
        const heldSha = check(current, [200], "read lock ref").body.object.sha;
        const fresh = held?.sha !== heldSha;
        if (fresh) held = await readLock(api, heldSha);
        if (sameHolder(held.holder, holder)) {
          // A create/takeover that succeeded but whose response was lost.
          log(`fixture lock is already held by this run (${heldSha})`);
          return heldSha;
        }
        const age = now() - held.date;
        let why =
          age > STALE_MS ? `held ${Math.round(age / 60_000)} min` : null;
        if (!why && held.holder && (deep || fresh))
          why = await holderRunEnded(api, held.holder);
        if (why) {
          const mine = await newLockCommit(api, {
            tree,
            holder,
            parent: heldSha,
          });
          const moved = await api("PATCH", `/git/refs/${LOCK_REF}`, {
            sha: mine,
            force: false,
          });
          if (moved.status === 200) {
            log(
              `fixture lock taken over from a stale holder: ${why} (${mine})`
            );
            return mine;
          }
          // 422: another run moved or deleted it first (not a fast-forward any more).
          check(moved, [422], "take over lock ref");
          log("a stale fixture lock was taken by another run first; waiting");
        } else {
          const h = held.holder;
          const who = h
            ? `${h.workflow} run ${h.runId}#${h.attempt}`
            : "an unrecognised holder (age limit applies)";
          log(`waiting for the fixture lock, held by ${who}`);
        }
      }
    } catch (err) {
      if (!err.transient) throw err;
      log(`GitHub API hiccup, will retry: ${err.message}`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * Deletes the lock only if its recorded holder is this run; a no-op
 * otherwise. Retries transient failures, so a GitHub blip at the end of a
 * green run neither fails the job nor leaves the lock held.
 */
export async function release(
  api,
  { holder, sleep, log = console.error, tries = 5 }
) {
  for (let attempt = 1; ; attempt++) {
    try {
      const current = await api("GET", `/git/ref/${LOCK_REF}`);
      if (current.status === 404) {
        log("fixture lock is free; nothing to release");
        return false;
      }
      const heldSha = check(current, [200], "read lock ref").body.object.sha;
      const held = await readLock(api, heldSha);
      if (!sameHolder(held.holder, holder)) {
        log(
          `fixture lock is held by another run (${heldSha}); not touching it`
        );
        return false;
      }
      // 422 = already deleted (a retry after a lost response).
      check(
        await api("DELETE", `/git/refs/${LOCK_REF}`),
        [204, 422],
        "delete lock ref"
      );
      log("fixture lock released");
      return true;
    } catch (err) {
      if (!err.transient || attempt >= tries) throw err;
      log(`GitHub API hiccup releasing the lock, will retry: ${err.message}`);
      await sleep(10_000);
    }
  }
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
