import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The edited-to-≤3★ alert goes out only once the sync page that carries the
 * edit has committed: a page whose guarded commit fails (lease lost) sends
 * nothing, and the next sync that does commit it sends the one alert. The
 * failure is injected at the page's commit — not the purge before the pass,
 * which would stop the run before the edit is even seen.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
/** `failCall`: the Nth guarded commit of a sync throws (1 = the purge before the pass, 2 = the first page). */
const fail = vi.hoisted(() => ({ failCall: 0, calls: 0 }));
vi.mock("@/lib/gbp/sync/lease", async (orig) => {
  const real = await orig<typeof import("@/lib/gbp/sync/lease")>();
  return {
    ...real,
    commitGuarded: async (...args: Parameters<typeof real.commitGuarded>) => {
      fail.calls += 1;
      if (fail.calls === fail.failCall) throw new real.LeaseLostError();
      return real.commitGuarded(...args);
    },
  };
});

import { SA, mem } from "@/test/gbp-sync-harness";
import { putFixtureReview, resetAutoReply, reviewDoc, sync, syncAndRun } from "@/test/auto-reply-harness";
import { autoReplyAlertsCollection } from "./alerts";

const ORIGINAL = { ...process.env };
const edited = () => mem.list(autoReplyAlertsCollection(SA)).filter((a) => a.kind === "edited_low");

beforeEach(() => {
  resetAutoReply();
  fail.failCall = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("a failed page commit sends no alert; the sync that commits the edit sends one", async () => {
  await syncAndRun();
  expect(reviewDoc("fake-a1").autoReplied).toBeTruthy();
  putFixtureReview("fake-a1", 1, "Worse now", 28);
  fail.calls = 0;
  fail.failCall = 2;
  await sync();
  expect(fail.calls).toBe(2);
  expect(reviewDoc("fake-a1").starRating).toBe(5);
  expect(edited()).toEqual([]);
  fail.failCall = 0;
  await sync();
  expect(reviewDoc("fake-a1").starRating).toBe(1);
  expect(edited()).toHaveLength(1);
});
