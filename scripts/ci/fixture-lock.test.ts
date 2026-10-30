import { describe, expect, it } from "vitest";
import {
  LOCK_REF,
  STALE_MS,
  Superseded,
  acquire,
  release,
} from "./fixture-lock.mjs";

type Res = { status: number; body: unknown };

/**
 * In-memory stand-in for the four GitHub endpoints the lock uses, with the
 * same semantics the lock relies on: ref create fails 422 when the ref exists,
 * a force:false update fails 422 unless the new commit descends from the
 * current one, and a commit's date is the server clock at creation.
 */
function fakeGitHub(clock: { t: number }) {
  const commits = new Map<
    string,
    { message: string; parents: string[]; date: number }
  >();
  const runs = new Map<string, string>(); // "runId/attempt" -> status
  let ref: string | null = null;
  let n = 0;
  const descends = (sha: string, from: string): boolean =>
    sha === from ||
    (commits.get(sha)?.parents ?? []).some((p) => descends(p, from));
  const api = async (
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Res> => {
    if (method === "POST" && path === "/git/commits") {
      const sha = `c${++n}`;
      commits.set(sha, {
        message: body!.message as string,
        parents: body!.parents as string[],
        date: clock.t,
      });
      return { status: 201, body: { sha } };
    }
    const commit = path.match(/^\/git\/commits\/(.+)$/);
    if (method === "GET" && commit) {
      const c = commits.get(commit[1])!;
      return {
        status: 200,
        body: {
          message: c.message,
          committer: { date: new Date(c.date).toISOString() },
        },
      };
    }
    const run = path.match(/^\/actions\/runs\/(.+)\/attempts\/(.+)$/);
    if (method === "GET" && run) {
      const status = runs.get(`${run[1]}/${run[2]}`);
      return status
        ? { status: 200, body: { status, html_url: "u" } }
        : { status: 404, body: null };
    }
    if (method === "POST" && path === "/git/refs") {
      expect(body!.ref).toBe(`refs/${LOCK_REF}`);
      if (ref)
        return { status: 422, body: { message: "Reference already exists" } };
      ref = body!.sha as string;
      return { status: 201, body: {} };
    }
    expect(path.endsWith(LOCK_REF)).toBe(true);
    if (method === "GET")
      return ref
        ? { status: 200, body: { object: { sha: ref } } }
        : { status: 404, body: null };
    if (method === "PATCH") {
      expect(body!.force).toBe(false);
      if (!ref || !descends(body!.sha as string, ref))
        return { status: 422, body: { message: "not a fast forward" } };
      ref = body!.sha as string;
      return { status: 200, body: {} };
    }
    if (method === "DELETE") {
      if (!ref) return { status: 422, body: null };
      ref = null;
      return { status: 204, body: null };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, runs, ref: () => ref, setRef: (s: string | null) => (ref = s) };
}

const holder = (runId: string) => ({ runId, attempt: "1", workflow: "CI" });
const quiet = () => {};
const noSleep = () => Promise.reject(new Error("should not wait"));

describe("fixture lock", () => {
  it("acquires a free lock at once and releases it", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    const sleep = () => Promise.reject(new Error("should not wait"));
    const mine = await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep,
      log: quiet,
    });
    expect(gh.ref()).toBe(mine);
    expect(
      await release(gh.api, { holder: holder("1"), sleep: noSleep, log: quiet })
    ).toBe(true);
    expect(gh.ref()).toBeNull();
  });

  it("waits (never steals) while the holder's run is still in progress, then takes the freed lock", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    gh.runs.set("1/1", "in_progress");
    const first = await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: quiet as never,
      log: quiet,
    });
    let waits = 0;
    const sleep = async () => {
      if (++waits > 5) throw new Error("never took the freed lock");
      clock.t += 60_000;
      expect(gh.ref()).toBe(first); // still held while we wait
      if (waits === 3)
        await release(gh.api, {
          holder: holder("1"),
          sleep: noSleep,
          log: quiet,
        });
    };
    const second = await acquire(gh.api, {
      tree: "t",
      holder: holder("2"),
      now: () => clock.t,
      sleep,
      log: quiet,
    });
    expect(waits).toBe(3);
    expect(second).not.toBe(first);
    expect(gh.ref()).toBe(second);
  });

  it("takes over when the holder's run completed without releasing, or is gone", async () => {
    for (const status of ["completed", undefined]) {
      const clock = { t: 0 };
      const gh = fakeGitHub(clock);
      const crashed = await acquire(gh.api, {
        tree: "t",
        holder: holder("1"),
        now: () => clock.t,
        sleep: quiet as never,
        log: quiet,
      });
      if (status) gh.runs.set("1/1", status);
      const sleep = () => Promise.reject(new Error("should not wait"));
      const mine = await acquire(gh.api, {
        tree: "t",
        holder: holder("2"),
        now: () => clock.t,
        sleep,
        log: quiet,
      });
      expect(mine).not.toBe(crashed);
      expect(gh.ref()).toBe(mine);
    }
  });

  it("takes over a lock older than the stale limit even if its run looks alive", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    gh.runs.set("1/1", "in_progress");
    await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: quiet as never,
      log: quiet,
    });
    clock.t = STALE_MS - 1;
    let waits = 0;
    const sleep = async () => {
      if (++waits > 3) throw new Error("never took over the aged lock");
      clock.t = STALE_MS + 1;
    };
    const mine = await acquire(gh.api, {
      tree: "t",
      holder: holder("2"),
      now: () => clock.t,
      sleep,
      log: quiet,
    });
    expect(waits).toBe(1);
    expect(gh.ref()).toBe(mine);
  });

  it("lets only one of two runs take over the same stale lock", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    const stale = await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: quiet as never,
      log: quiet,
    });
    gh.runs.set("1/1", "completed");
    gh.runs.set("2/1", "in_progress");
    // Run 3 reads the same stale ref as run 2 but its PATCH lands second.
    const racing = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) => {
      if (method === "PATCH" && gh.ref() === stale) {
        const noWait = () =>
          Promise.reject(new Error("run 2 should have taken over at once"));
        await acquire(gh.api, {
          tree: "t",
          holder: holder("2"),
          now: () => clock.t,
          sleep: noWait,
          log: quiet,
        });
      }
      return gh.api(method, path, body);
    };
    const sleep = async () => {
      throw new Error("lost the race and waited");
    };
    await expect(
      acquire(racing, {
        tree: "t",
        holder: holder("3"),
        now: () => clock.t,
        sleep,
        log: quiet,
      })
    ).rejects.toThrow("lost the race and waited");
    expect(gh.ref()).not.toBe(stale);
  });

  it("release never deletes a lock another run now holds", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    gh.runs.set("1/1", "completed");
    const other = await acquire(gh.api, {
      tree: "t",
      holder: holder("2"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    expect(
      await release(gh.api, { holder: holder("1"), sleep: noSleep, log: quiet })
    ).toBe(false);
    expect(gh.ref()).toBe(other);
  });

  it("adopts its own lock when the create succeeded but the response was lost", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    gh.runs.set("1/1", "in_progress");
    let lost = false;
    const flaky = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) => {
      const res = await gh.api(method, path, body);
      if (method === "POST" && path === "/git/refs" && !lost) {
        lost = true;
        return { status: 599, body: { error: "socket hang up" } };
      }
      return res;
    };
    let waits = 0;
    const sleep = async () => {
      if (++waits > 2) throw new Error("waited on its own lock");
    };
    const mine = await acquire(flaky, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep,
      log: quiet,
    });
    expect(lost).toBe(true);
    expect(gh.ref()).toBe(mine);
    // ...and can still release it, with no sha carried between steps.
    expect(
      await release(gh.api, { holder: holder("1"), sleep: noSleep, log: quiet })
    ).toBe(true);
  });

  it("release retries a transient failure instead of failing the job", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    let failed = 0;
    const flaky = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) =>
      method === "DELETE" && failed++ === 0
        ? { status: 502, body: null }
        : gh.api(method, path, body);
    let slept = 0;
    const sleep = async () => {
      slept++;
    };
    expect(
      await release(flaky, { holder: holder("1"), sleep, log: quiet })
    ).toBe(true);
    expect(slept).toBe(1);
    expect(gh.ref()).toBeNull();
  });

  it("stops waiting once its PR has a newer head", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    gh.runs.set("1/1", "in_progress");
    await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    let checks = 0;
    const superseded = async () =>
      ++checks >= 2 ? "PR #1 has a newer head" : null;
    let waits = 0;
    const sleep = async () => {
      if (++waits > 20) throw new Error("kept waiting");
    };
    await expect(
      acquire(gh.api, {
        tree: "t",
        holder: holder("2"),
        now: () => clock.t,
        sleep,
        superseded,
        log: quiet,
      })
    ).rejects.toBeInstanceOf(Superseded);
    expect(checks).toBe(2);
  });

  it("fails the step on a permissions error or an unexpected 422 instead of spinning", async () => {
    const forbidden = async () => ({
      status: 403,
      body: { message: "Resource not accessible by integration" },
    });
    await expect(
      acquire(forbidden, {
        tree: "t",
        holder: holder("1"),
        sleep: noSleep,
        log: quiet,
      })
    ).rejects.toThrow(/HTTP 403/);
    const gh = fakeGitHub({ t: 0 });
    const badTree = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) =>
      method === "POST" && path === "/git/refs"
        ? { status: 422, body: { message: "Object does not exist" } }
        : gh.api(method, path, body);
    await expect(
      acquire(badTree, {
        tree: "t",
        holder: holder("1"),
        sleep: noSleep,
        log: quiet,
      })
    ).rejects.toThrow(/HTTP 422/);
  });

  it("treats a rate-limit 403 as transient", async () => {
    const gh = fakeGitHub({ t: 0 });
    let limited = 0;
    const api = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) =>
      limited++ === 0
        ? { status: 403, body: { message: "API rate limit exceeded" } }
        : gh.api(method, path, body);
    let slept = 0;
    const sleep = async () => {
      slept++;
    };
    const mine = await acquire(api, {
      tree: "t",
      holder: holder("1"),
      sleep,
      log: quiet,
    });
    expect(slept).toBe(1);
    expect(gh.ref()).toBe(mine);
  });
});
