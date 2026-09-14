import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/sub-accounts/[id]/reputation/sentiment/run — "Analyse now".
 * Admin only, both gates on, once a minute; runs the same classification
 * the sync runs. Real tenancy, real sync (fake GBP), real fenced AI fake.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, asUser, mem, resetSync, reviews } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { fakeLogPath } from "@/lib/reputation/ai/fake";
import { sentimentLeasePath } from "@/lib/reputation/sentiment";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const billed = () => ((mem.read(fakeLogPath(SA))?.calls ?? []) as Array<{ ids: string[] }>).flatMap((c) => c.ids);

async function press(uid = "uid_admin") {
  const res = await POST(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/reputation/sentiment/run`, uid, "POST"), {
    params: Promise.resolve({ id: SA }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
function setGates(reviewsAi: boolean, google = true) {
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: reviewsAi, googleEnabledByAgency: google });
}
const liftCooldown = () => mem.seed(sentimentLeasePath(SA), { ...mem.read(sentimentLeasePath(SA)), lastManualAt: 0 });

beforeEach(async () => {
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  setGates(true);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("who and when", () => {
  it.each([
    ["a collaborator", "uid_collab"],
    ["an admin of another sub-account", "uid_other_admin"],
    ["a non-member", "uid_stranger"],
  ])("refuses %s", async (_l, uid) => {
    expect((await press(uid)).status).toBe(403);
    expect(billed()).toEqual([]);
  });

  it.each([
    ["Reviews AI off", false, true, "Reviews AI is off for this sub-account"],
    ["Google off", true, false, "Google reviews are not enabled"],
  ])("refuses with gate_off when %s", async (_l, ai, google, words) => {
    setGates(ai, google);
    const { status, body } = await press();
    expect(status).toBe(403);
    expect(body.code).toBe("gate_off");
    expect(String(body.error)).toContain(words);
    expect(billed()).toEqual([]);
  });

  it("at most once a minute", async () => {
    expect((await press()).status).toBe(200);
    const again = await press();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("too_soon");
  });
});

describe("the run", () => {
  it("classifies and answers with the counts; a second press re-bills nothing", async () => {
    const { status, body } = await press();
    expect(status).toBe(200);
    expect(body.outcome).toMatchObject({ status: "ran", aiConfigured: true, classified: 7, skipped: 0, failed: 0 });
    expect(reviews().every((r) => r.sentiment)).toBe(true);
    liftCooldown();
    expect((await press()).body.outcome).toMatchObject({ classified: 0 });
    expect(billed()).toHaveLength(6);
  });
});
