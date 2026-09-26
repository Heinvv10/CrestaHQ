import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Dev and CI run the fakes on the PRODUCTION Firestore. With either fake —
 * GBP or Reviews AI — sentiment after a sync serves the fixture agency only:
 * a sub-account of any other agency handed to it in the same batch gets
 * nothing written (no label, no lease, no usage count), while the fixture's
 * own sub-account IS classified — the control that keeps this from passing
 * vacuously.
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

import { AGENCY, FOREIGN_AGENCY, FOREIGN_SA, SA, mem, resetSync, reviews } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { classifySyncedRuns } from "./sentiment-after";
import { sentimentUsagePath } from "./sentiment-calls";
import { sentimentLeasePath } from "./sentiment-lease";

const ORIGINAL = { ...process.env };
const FAR = Date.now() + 24 * 3600_000;

/** Every doc under one sub-account, keyed by path. */
const tree = (sa: string) =>
  Object.fromEntries(mem.all().filter((d) => d.path === `subAccounts/${sa}` || d.path.startsWith(`subAccounts/${sa}/`)).map((d) => [d.path, d.data]));

beforeEach(async () => {
  ai.aiReal = false;
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = AGENCY;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: true });
  // The foreign tenant: SA's doc, reviews and connection, all gates on — another agency's.
  for (const [path, data] of Object.entries(tree(SA))) {
    mem.seed(path.replace(`subAccounts/${SA}`, `subAccounts/${FOREIGN_SA}`), path === `subAccounts/${SA}` ? { ...data, agencyId: FOREIGN_AGENCY } : data);
  }
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

/** The foreign tenant first, so the batch carrying on past its refusal is proven too. */
async function classifyBoth() {
  const before = tree(FOREIGN_SA);
  expect(reviews(FOREIGN_SA).length).toBeGreaterThan(0);
  await classifySyncedRuns([
    { subAccountId: FOREIGN_SA, created: 1, updated: 0 },
    { subAccountId: SA, created: 1, updated: 0 },
  ], FAR);
  return before;
}

function expectForeignUntouched(before: Record<string, unknown>) {
  expect(tree(FOREIGN_SA)).toEqual(before);
  expect(reviews(FOREIGN_SA).some((r) => r.sentiment)).toBe(false);
  expect(mem.read(sentimentLeasePath(FOREIGN_SA))).toBeUndefined();
  expect(mem.read(sentimentUsagePath(FOREIGN_SA))).toBeUndefined();
}

it("the GBP fake's fence alone (Reviews AI real) keeps another agency's sub-account out; the fixture's is classified", async () => {
  ai.aiReal = true;
  const before = await classifyBoth();
  expectForeignUntouched(before);
  expect(reviews(SA).some((r) => r.sentiment)).toBe(true);
  expect(mem.read(sentimentLeasePath(SA))).toBeDefined();
});

it("the Reviews AI fake's fence alone (GBP real) keeps another agency's sub-account out; the fixture's is classified", async () => {
  process.env.GBP_PROVIDER = "google";
  const before = await classifyBoth();
  expectForeignUntouched(before);
  expect(reviews(SA).some((r) => r.sentiment)).toBe(true);
  expect(mem.read(sentimentLeasePath(SA))).toBeDefined();
  expect(mem.read(sentimentUsagePath(SA))).toBeDefined();
});
