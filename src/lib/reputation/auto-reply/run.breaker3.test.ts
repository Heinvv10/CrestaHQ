import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { ACCOUNT, LOC_A, SA, OTHER_SA, asUser, mem, setScenario } from "@/test/gbp-sync-harness";
import { neverPath, patchSettings, posts, resetAutoReply, sync, syncAndRun } from "@/test/auto-reply-harness";
import { PUT } from "@/app/api/sub-accounts/[id]/google/listing/route";

const ORIGINAL = { ...process.env };
const ACCOUNT2 = "accounts/second-manager";
const BASE = `http://127.0.0.1:3100/api/sub-accounts/${SA}`;
const params = { params: Promise.resolve({ id: SA }) };
const setA1Reply = (reply: { comment: string; updateTime: string } | null) => setScenario(SA, (s) => {
  s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-a1")!.reply = reply;
});
const a1PostsAny = () => posts().filter((c) => c.reviewName.endsWith("/reviews/fake-a1"));

beforeEach(() => {
  resetAutoReply();
  patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "approval", 5: "auto" } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("BREAKER round 3", () => {
  it("R3-1: same location re-selected under ANOTHER Google account → not disabled, new review doc ids, marker bypassed → auto-post over a deleted reply", async () => {
    setA1Reply({ comment: "Thanks from GHL.", updateTime: "2026-08-28T10:00:00Z" });
    await syncAndRun();
    setA1Reply(null); // owner deletes it
    await syncAndRun();
    expect(a1PostsAny()).toHaveLength(0);
    expect(mem.read(neverPath("fake-a1"))).toBeTruthy();

    // A second Google account (e.g. a location group / another manager) also manages LOC_A.
    setScenario(SA, (s) => {
      s.accounts.push({ ...s.accounts[0], name: ACCOUNT2, accountName: "Second manager" });
      s.locations[ACCOUNT2] = s.locations[ACCOUNT].filter((l) => l.name === LOC_A);
    });
    const res = await PUT(asUser(`${BASE}/google/listing`, "uid_admin", "PUT", JSON.stringify({ accountName: ACCOUNT2, locationName: LOC_A })), params);
    expect(res.status).toBe(200);
    // Google names reviews under the account they were listed through.
    setScenario(SA, (s) => {
      for (const r of s.reviews[LOC_A].reviews) r.name = r.name.replace(ACCOUNT, ACCOUNT2);
    });
    const enabledAfter = (mem.read(`subAccounts/${SA}`)!.reviewsAutoReply as { enabled: boolean }).enabled;
    await syncAndRun();
    expect({ enabledAfter, a1Posts: a1PostsAny().length }).toEqual({ enabledAfter: false, a1Posts: 0 });
  });

  it("R3-2: marker writes are bounded — a replied review's marker is written once, not on every sync", async () => {
    setA1Reply({ comment: "Thanks.", updateTime: "2026-08-28T10:00:00Z" });
    await sync();
    const path = neverPath("fake-a1");
    const first = JSON.stringify(mem.read(path));
    await new Promise((r) => setTimeout(r, 5));
    await sync();
    await sync();
    expect(JSON.stringify(mem.read(path))).toBe(first);
  });

  it("R3-3: tenancy — SA's marker never appears under OTHER_SA and vice versa", async () => {
    setA1Reply({ comment: "Thanks.", updateTime: "2026-08-28T10:00:00Z" });
    await sync();
    expect(mem.list(`subAccounts/${OTHER_SA}/autoReplyNever`)).toEqual([]);
    expect(mem.list(`subAccounts/${SA}/autoReplyNever`).every((m) => m.subAccountId === SA)).toBe(true);
  });
});
