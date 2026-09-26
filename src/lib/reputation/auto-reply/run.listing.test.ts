import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rev 5 ruling: ANY listing change or clear switches review auto-reply off
 * (modes kept) — resuming needs an explicit re-enable. Driven through the
 * real listing route (PUT / DELETE) and the real settings route on the
 * in-memory store, then the engine.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { ACCOUNT, LOC_A, LOC_NORTH, SA, asUser, mem, setScenario } from "@/test/gbp-sync-harness";
import { A1, patchSettings, posts, resetAutoReply, reviewNameOf, sync, syncAndRun } from "@/test/auto-reply-harness";
import { dismissAutoReply } from "./store";
import { clearListing } from "@/lib/gbp/listing-events";
import { DELETE, PUT } from "@/app/api/sub-accounts/[id]/google/listing/route";
import { GET as GET_SETTINGS, PUT as PUT_SETTINGS } from "@/app/api/sub-accounts/[id]/reputation/auto-reply/route";

const ORIGINAL = { ...process.env };
const BASE = `http://127.0.0.1:3100/api/sub-accounts/${SA}`;
const params = { params: Promise.resolve({ id: SA }) };
const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "approval", 5: "auto" };
const settings = () => mem.read(`subAccounts/${SA}`)!.reviewsAutoReply as Record<string, unknown>;
const select = (locationName: string) =>
  PUT(asUser(`${BASE}/google/listing`, "uid_admin", "PUT", JSON.stringify({ accountName: ACCOUNT, locationName })), params);
const a1Posts = () => posts().filter((c) => c.reviewName === reviewNameOf("fake-a1"));

beforeEach(() => {
  resetAutoReply();
  patchSettings({ modes: MODES });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("listing A→B→A: auto-reply is off, modes kept; nothing posts until it is re-enabled", async () => {
  await sync();
  expect((await select(LOC_NORTH)).status).toBe(200);
  expect(settings()).toMatchObject({ enabled: false, modes: MODES });
  expect((await select(LOC_A)).status).toBe(200);
  await syncAndRun();
  expect(a1Posts()).toEqual([]);

  const body = JSON.stringify({ enabled: true, modes: MODES, includeBacklog: true });
  expect((await PUT_SETTINGS(asUser(`${BASE}/reputation/auto-reply`, "uid_admin", "PUT", body), params)).status).toBe(200);
  await syncAndRun();
  expect(a1Posts()).toHaveLength(1);
});

it("re-selecting the SAME listing leaves auto-reply on", async () => {
  expect((await select(LOC_A)).status).toBe(200);
  expect(settings().enabled).toBe(true);
});

it("clearing the listing (DELETE, and a disconnect's clear) switches it off", async () => {
  expect((await DELETE(asUser(`${BASE}/google/listing`, "uid_admin", "DELETE"), params)).status).toBe(200);
  expect(settings()).toMatchObject({ enabled: false, modes: MODES });
  patchSettings({ enabled: true });
  const listing = { accountName: ACCOUNT, locationName: LOC_A };
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleListing: listing });
  await clearListing(SA, "uid_admin", "disconnected");
  expect(settings().enabled).toBe(false);
});

const ACCOUNT2 = "accounts/second-manager";
const reEnable = () =>
  PUT_SETTINGS(asUser(`${BASE}/reputation/auto-reply`, "uid_admin", "PUT", JSON.stringify({ enabled: true, modes: MODES, includeBacklog: true })), params);
/** The same location selected through ANOTHER Google account: Google names its reviews under that account. */
async function switchAccount() {
  setScenario(SA, (s) => {
    s.accounts.push({ ...s.accounts[0], name: ACCOUNT2, accountName: "Second manager" });
    s.locations[ACCOUNT2] = s.locations[ACCOUNT].filter((l) => l.name === LOC_A);
  });
  expect((await PUT(asUser(`${BASE}/google/listing`, "uid_admin", "PUT", JSON.stringify({ accountName: ACCOUNT2, locationName: LOC_A })), params)).status).toBe(200);
  setScenario(SA, (s) => {
    for (const r of s.reviews[LOC_A].reviews) r.name = r.name.replace(ACCOUNT, ACCOUNT2);
  });
}
const a1AnyAccount = () => posts().filter((c) => c.reviewName.endsWith("/reviews/fake-a1"));

it("the same location through another Google account is a listing change: auto-reply off, cache cleared", async () => {
  await sync();
  await switchAccount();
  expect(settings()).toMatchObject({ enabled: false, modes: MODES });
  expect(mem.list(`subAccounts/${SA}/gbpReviews`)).toEqual([]);
});

it("a deleted reply's marker survives an account switch, even once auto-reply is re-enabled", async () => {
  setScenario(SA, (s) => void (s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-a1")!.reply = { comment: "Human.", updateTime: "2026-08-28T10:00:00Z" }));
  await sync();
  setScenario(SA, (s) => void (s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-a1")!.reply = null));
  await sync();
  await switchAccount();
  expect((await reEnable()).status).toBe(200);
  await syncAndRun();
  expect(a1AnyAccount()).toEqual([]);
});

it("a Discard survives an account switch, even once auto-reply is re-enabled", async () => {
  await sync();
  const doc = mem.read(`subAccounts/${SA}/gbpReviews/${A1}`)!;
  mem.seed(`subAccounts/${SA}/gbpReviews/${A1}`, { ...doc, pendingReply: { text: "x", textHash: "h", basisHash: "b", reason: "approval", at: new Date(), model: "fake" } });
  expect(await dismissAutoReply(SA, A1, "uid_admin", new Date())).toBe("dismissed");
  await switchAccount();
  expect((await reEnable()).status).toBe(200);
  await syncAndRun();
  expect(a1AnyAccount()).toEqual([]);
  expect(posts()).toHaveLength(0); // fake-a2 is 4★ = Approval here
});

it("a sub-account without auto-reply settings gets none written", async () => {
  const { reviewsAutoReply: _gone, ...rest } = mem.read(`subAccounts/${SA}`)!;
  mem.seed(`subAccounts/${SA}`, rest);
  await select(LOC_NORTH);
  await clearListing(SA, "uid_admin", "admin_cleared");
  expect(mem.read(`subAccounts/${SA}`)!.reviewsAutoReply).toBeUndefined();
});

describe("disabledReason — the card's \"switched off because the listing changed\" note", () => {
  const shown = async () =>
    ((await (await GET_SETTINGS(asUser(`${BASE}/reputation/auto-reply`, "uid_admin"), params)).json()) as { disabledReason: unknown }).disabledReason;

  it("a listing change of an ON auto-reply notes it; re-enabling clears it", async () => {
    expect((await select(LOC_NORTH)).status).toBe(200);
    expect(settings()).toMatchObject({ enabled: false, disabledReason: "listing_changed" });
    expect(await shown()).toBe("listing_changed");
    expect((await select(LOC_A)).status).toBe(200);
    expect((await reEnable()).status).toBe(200);
    expect(settings()).toMatchObject({ enabled: true, disabledReason: null });
    expect(await shown()).toBeNull();
  });

  it("DELETE and a disconnect's clear note it too", async () => {
    expect((await DELETE(asUser(`${BASE}/google/listing`, "uid_admin", "DELETE"), params)).status).toBe(200);
    expect(settings().disabledReason).toBe("listing_changed");
    patchSettings({ enabled: true, disabledReason: null });
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleListing: { accountName: ACCOUNT, locationName: LOC_A } });
    await clearListing(SA, "uid_admin", "disconnected");
    expect(settings()).toMatchObject({ enabled: false, disabledReason: "listing_changed" });
  });

  it("an auto-reply the admin had already switched off gets no note", async () => {
    patchSettings({ enabled: false });
    expect((await select(LOC_NORTH)).status).toBe(200);
    expect(settings().disabledReason).toBeUndefined();
    await clearListing(SA, "uid_admin", "admin_cleared");
    expect(settings().disabledReason).toBeUndefined();
  });

  it("re-selecting the SAME listing adds no note", async () => {
    expect((await select(LOC_A)).status).toBe(200);
    expect(settings().disabledReason).toBeUndefined();
  });
});
