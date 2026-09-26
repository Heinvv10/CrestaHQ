import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Rev 5 ruling: ANY listing change or clear switches review auto-reply off
 * (modes kept) — resuming needs an explicit re-enable. Driven through the
 * real listing route (PUT / DELETE) and the real settings route on the
 * in-memory store, then the engine.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { ACCOUNT, LOC_A, LOC_NORTH, SA, asUser, mem } from "@/test/gbp-sync-harness";
import { patchSettings, posts, resetAutoReply, reviewNameOf, sync, syncAndRun } from "@/test/auto-reply-harness";
import { clearListing } from "@/lib/gbp/listing-events";
import { DELETE, PUT } from "@/app/api/sub-accounts/[id]/google/listing/route";
import { PUT as PUT_SETTINGS } from "@/app/api/sub-accounts/[id]/reputation/auto-reply/route";

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

it("a sub-account without auto-reply settings gets none written", async () => {
  const { reviewsAutoReply: _gone, ...rest } = mem.read(`subAccounts/${SA}`)!;
  mem.seed(`subAccounts/${SA}`, rest);
  await select(LOC_NORTH);
  await clearListing(SA, "uid_admin", "admin_cleared");
  expect(mem.read(`subAccounts/${SA}`)!.reviewsAutoReply).toBeUndefined();
});
