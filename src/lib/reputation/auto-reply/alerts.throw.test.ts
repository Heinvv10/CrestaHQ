import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * A run that holds a review and then throws must still send its held alert:
 * the next run sees that review as already held and would never count it.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("./post", async (orig) => ({
  ...(await orig<typeof import("./post")>()),
  postQueued: async () => {
    throw new Error("injected: post blew up");
  },
}));

import { SA, mem } from "@/test/gbp-sync-harness";
import { pendingOf, putFixtureReview, resetAutoReply, syncAndRun } from "@/test/auto-reply-harness";
import { autoReplyAlertsCollection } from "./alerts";

const ORIGINAL = { ...process.env };
const held = () => mem.list(autoReplyAlertsCollection(SA)).filter((a) => a.kind === "held");

beforeEach(() => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("held first (newest), then the auto post throws → the run fails AND the held alert is sent, once", async () => {
  putFixtureReview("fake-h1", 3, "Slow install", 29);
  expect(await syncAndRun()).toBeNull();
  expect(pendingOf("fake-h1")).toMatchObject({ reason: "approval" });
  expect(held()).toMatchObject([{ count: 1 }]);
  await syncAndRun();
  expect(held()).toHaveLength(1);
});
