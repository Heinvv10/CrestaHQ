import { describe, expect, it } from "vitest";
import { Superseded, acquire, holds, release } from "./fixture-lock-core.mjs";
import { fakeGitHub, holder, noSleep, quiet } from "./fixture-lock.fake";

describe("fixture lock: ownership and faults", () => {
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

  it("holds() is true only for the run attempt that holds the lock", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    expect(await holds(gh.api, { holder: holder("1") })).toBe(false);
    await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    expect(await holds(gh.api, { holder: holder("1") })).toBe(true);
    expect(await holds(gh.api, { holder: holder("2") })).toBe(false);
    // A "re-run failed jobs" is the same run id with the next attempt.
    expect(
      await holds(gh.api, { holder: { ...holder("1"), attempt: "2" } })
    ).toBe(false);
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
      method === "PATCH" && failed++ === 0
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
    expect(await holds(gh.api, { holder: holder("1") })).toBe(false);
  });

  it("release is compare-and-swap: never frees a lock that moved after it was read", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    let other: string | null = null;
    // Another run's commit lands on the ref between release's read and its
    // update (the race a read-then-DELETE could not survive).
    const racing = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) => {
      if (method === "PATCH" && !other) {
        other = (
          (await gh.api("POST", "/git/commits", {
            message: JSON.stringify(holder("2")),
            tree: "t",
            parents: [gh.ref()],
          })) as { body: { sha: string } }
        ).body.sha;
        gh.setRef(other);
      }
      return gh.api(method, path, body);
    };
    expect(
      await release(racing, { holder: holder("1"), sleep: noSleep, log: quiet })
    ).toBe(false);
    expect(gh.ref()).toBe(other);
    expect(await holds(gh.api, { holder: holder("2") })).toBe(true);
  });

  it("release fails on a 422 that is not a moved ref instead of spinning", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    let patches = 0;
    const broken = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) =>
      method === "PATCH" && ++patches
        ? { status: 422, body: { message: "Object does not exist" } }
        : gh.api(method, path, body);
    await expect(
      release(broken, { holder: holder("1"), sleep: noSleep, log: quiet })
    ).rejects.toThrow("release lock ref: HTTP 422");
    expect(patches).toBe(1);
  });

  it("takeover fails on a 422 that is not a moved ref instead of waiting", async () => {
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
    let patches = 0;
    const broken = async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ) =>
      method === "PATCH" && ++patches
        ? { status: 422, body: { message: "Object does not exist" } }
        : gh.api(method, path, body);
    const sleep = async () => {
      throw new Error("waited after a non-fast-forward-unrelated 422");
    };
    await expect(
      acquire(broken, {
        tree: "t",
        holder: holder("2"),
        now: () => clock.t,
        sleep,
        log: quiet,
      })
    ).rejects.toThrow("take over lock ref: HTTP 422");
    expect(patches).toBe(1);
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
