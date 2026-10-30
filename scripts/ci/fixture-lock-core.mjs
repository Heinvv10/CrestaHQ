// Cross-run mutex for the E2E fixture tenants, held as a git ref.
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
// can live: the lock is held from the end of the acquire job until the
// release job, and the E2E job's own timeout (in between) bounds that. The
// holder run stays in progress across those jobs, so it is never judged stale
// early. Ownership is the holder recorded in the ref's commit, not a sha kept
// by the job, so a lost API response or a cancel mid-acquire cannot leave
// this run unable to recognise (and release) its own lock.
//
// GITHUB_TOKEN allows ~1,000 API calls per hour per repository, shared by
// every waiter, so a waiter polls once a minute, reads a holder's commit once
// per holder, and checks the holder run / its own PR only every DEEP_EVERY
// polls (~85 calls per waiter-hour).
//
// The CLI wrapper the workflows call is scripts/ci/fixture-lock.mjs.

export const LOCK_REF = "ci-locks/e2e-fixtures";
export const STALE_MS = 150 * 60_000;
export const POLL_MS = 60_000;
export const DEEP_EVERY = 5;

const rateLimited = (res) =>
  res.status === 429 ||
  (res.status === 403 && /rate limit/i.test(JSON.stringify(res.body)));

export function check(res, ok, what) {
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
  { tree, holder, now = Date.now, sleep, superseded, log = console.error }
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
 * Whether this run attempt holds the lock. Read-only (contents: read), so the
 * job that runs the suite can refuse to start without the lock — e.g. after a
 * "re-run failed jobs", which reruns it but not the job that acquired.
 */
export async function holds(api, { holder }) {
  const current = await api("GET", `/git/ref/${LOCK_REF}`);
  if (current.status === 404) return false;
  const heldSha = check(current, [200], "read lock ref").body.object.sha;
  return sameHolder((await readLock(api, heldSha)).holder, holder);
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
