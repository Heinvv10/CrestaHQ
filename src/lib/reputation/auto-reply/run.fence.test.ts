import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * CI's E2E job sets the kill switch (REVIEWS_AUTO_REPLY_ENABLED=1) while it
 * runs on the PRODUCTION Firestore with the GBP fake. In fake mode the engine
 * serves the fixture agency only: a sub-account of any other agency — even
 * one with auto-reply fully switched on — gets nothing read or written, not
 * even the lease.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
/** `aiReal`: the Reviews AI in real (OpenRouter) mode — stubbed so no model is ever called. */
const ai = vi.hoisted(() => ({ aiReal: false }));
vi.mock("@/lib/reputation/ai/mode", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/mode")>();
  return {
    ...real,
    reviewsAiMode: () => (ai.aiReal ? "openrouter" : real.reviewsAiMode()),
    reviewsAiConfigured: () => (ai.aiReal ? true : real.reviewsAiConfigured()),
  };
});
vi.mock("@/lib/reputation/ai/select", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/select")>();
  const refuse = async () => {
    throw new Error("stub: no model call in tests");
  };
  return {
    ...real,
    getReviewsAiFor: async (sa: string) =>
      ai.aiReal ? { model: "stub", classifySentiment: refuse, draftReply: refuse } : real.getReviewsAiFor(sa),
  };
});

import { FOREIGN_AGENCY, FOREIGN_SA, SA, mem } from "@/test/gbp-sync-harness";
import { resetAutoReply } from "@/test/auto-reply-harness";
import { autoReplyLeasePath } from "./store";
import { autoReplyAfterSync } from "./run";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  ai.aiReal = false;
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

it("the GBP fake's fence alone (Reviews AI real) keeps another agency's sub-account out — not even the lease", async () => {
  ai.aiReal = true;
  mem.seed(`subAccounts/${FOREIGN_SA}`, { ...mem.read(`subAccounts/${SA}`)!, agencyId: FOREIGN_AGENCY });
  expect(await run(FOREIGN_SA)).toBeNull();
  expect(mem.read(autoReplyLeasePath(FOREIGN_SA))).toBeUndefined();
  // The control: the fixture's own sub-account does get that far.
  await run(SA);
  expect(mem.read(autoReplyLeasePath(SA))).toBeDefined();
});
