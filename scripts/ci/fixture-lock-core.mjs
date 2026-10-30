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
// longer descends from the ref. Stale = the actions API shows the holder's run
// attempt has completed (or is gone). Age alone never frees a recognised
// holder — a slow but live run keeps its lock; STALE_MS applies only to a ref
// commit this script did not write (unparseable holder). Ownership is the
// holder recorded in the ref's commit, not a sha kept by the job, so a lost API
// response or a cancel mid-acquire cannot leave this run unable to recognise
// (and release) its own lock.
//
// Release is the same fast-forward-only update: the holder commits a
// "released" marker on top of its own lock commit. That update is a
// compare-and-swap on GitHub's side — it fails 422 unless the ref still points
// at the commit this run read — so a run can never free a lock someone else
// now holds. (A plain ref DELETE has no such check.) A released marker is
// taken over at once by the next waiter; the ref is created only the first
// time, when it does not exist yet.
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
  let released = false;
  try {
    const msg = JSON.parse(c.message);
    if (msg?.released) released = true;
    else if (msg?.runId && msg?.attempt) holder = msg;
  } catch {
    // Not written by this script; only the age limit can free it.
  }
  return {
    sha,
    holder,
    released,
    tree: c.tree?.sha,
    date: Date.parse(c.committer.date),
  };
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
        // A recognised holder is freed only by its run ending, never by age:
        // a slow live run must not lose the fixtures mid-suite.
        let why = null;
        if (held.released) why = "released";
        else if (held.holder) {
          if (deep || fresh) why = await holderRunEnded(api, held.holder);
        } else {
          const age = now() - held.date;
          if (age > STALE_MS)
            why = `unrecognised holder, held ${Math.round(age / 60_000)} min`;
        }
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
              held.released
                ? `fixture lock acquired (${mine})`
                : `fixture lock taken over from a stale holder: ${why} (${mine})`
            );
            return mine;
          }
          // 422: another run moved it first (not a fast-forward any more).
          check(moved, [422], "take over lock ref");
          log(
            "a free or stale fixture lock was taken by another run first; waiting"
          );
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
 * Frees the lock only if its recorded holder is this run; a no-op otherwise.
 * Compare-and-swap: commits a released marker on top of the lock commit it
 * just read and moves the ref there with force:false, which GitHub refuses
 * (422) if the ref moved in between — then it re-reads. Retries transient
 * failures, so a GitHub blip at the end of a green run neither fails the job
 * nor leaves the lock held.
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
        // Includes our own released marker after a lost response.
        log(
          `fixture lock is not held by this run (${heldSha}); not touching it`
        );
        return false;
      }
      const marker = check(
        await api("POST", "/git/commits", {
          message: JSON.stringify({ released: holder }),
          tree: held.tree,
          parents: [heldSha],
        }),
        [201],
        "create release commit"
      ).body.sha;
      const moved = await api("PATCH", `/git/refs/${LOCK_REF}`, {
        sha: marker,
        force: false,
      });
      // Only a not-fast-forward 422 means the ref moved; re-read (it can no
      // longer be ours). Any other 422 is a real fault and fails below.
      if (
        moved.status === 422 &&
        /fast.?forward/i.test(JSON.stringify(moved.body))
      ) {
        log("fixture lock moved while releasing; re-checking");
        continue;
      }
      check(moved, [200], "release lock ref");
      log("fixture lock released");
      return true;
    } catch (err) {
      if (!err.transient || attempt >= tries) throw err;
      log(`GitHub API hiccup releasing the lock, will retry: ${err.message}`);
      await sleep(10_000);
    }
  }
}
