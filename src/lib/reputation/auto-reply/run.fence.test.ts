import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * CI's E2E job sets the kill switch (REVIEWS_AUTO_REPLY_ENABLED=1) while it
 * runs on the PRODUCTION Firestore with the GBP fake. In fake mode the engine
 * serves the fixture agency only: a sub-account of any other agency — even
 * one with auto-reply fully switched on — gets nothing read or written, not
 * even the lease.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { FOREIGN_AGENCY, FOREIGN_SA, SA, mem } from "@/test/gbp-sync-harness";
import { resetAutoReply } from "@/test/auto-reply-harness";
import { autoReplyLeasePath } from "./store";
import { autoReplyAfterSync } from "./run";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

const run = (sa: string) => autoReplyAfterSync(sa, new Date(0), Date.now() + 60_000);

it("the fixture agency's sub-account runs (the control: it takes the lease)", async () => {
  expect(await run(SA)).not.toBeNull();
  expect(mem.read(autoReplyLeasePath(SA))).toBeDefined();
});

it("a sub-account of another agency, auto-reply on, gets no run and no write", async () => {
  mem.seed(`subAccounts/${FOREIGN_SA}`, { ...mem.read(`subAccounts/${SA}`)!, agencyId: FOREIGN_AGENCY });
  expect(await run(FOREIGN_SA)).toBeNull();
  expect(mem.read(autoReplyLeasePath(FOREIGN_SA))).toBeUndefined();
});
