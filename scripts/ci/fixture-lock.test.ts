import { describe, expect, it } from "vitest";
import {
  DEEP_EVERY,
  STALE_MS,
  acquire,
  release,
} from "./fixture-lock-core.mjs";
import { fakeGitHub, holder, noSleep, quiet } from "./fixture-lock.fake";

describe("fixture lock: acquire", () => {
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
  it("notices a watched holder's run ending on a later poll, with no new lock sha", async () => {
    const clock = { t: 0 };
    const gh = fakeGitHub(clock);
    gh.runs.set("1/1", "in_progress");
    const crashed = await acquire(gh.api, {
      tree: "t",
      holder: holder("1"),
      now: () => clock.t,
      sleep: noSleep,
      log: quiet,
    });
    let waits = 0;
    const sleep = async () => {
      if (++waits > DEEP_EVERY + 1)
        throw new Error("never re-checked the holder run");
      clock.t += 60_000;
      if (waits === 1) gh.runs.set("1/1", "completed");
    };
    const mine = await acquire(gh.api, {
      tree: "t",
      holder: holder("2"),
      now: () => clock.t,
      sleep,
      log: quiet,
    });
    expect(waits).toBe(DEEP_EVERY);
    expect(mine).not.toBe(crashed);
    expect(gh.ref()).toBe(mine);
  });
});
