import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Adopting an EXTRA listing's review link (MULTI_LISTING_V1_PLAN.md PR 5):
 * the same explicit admin compare-and-set, on THAT listing's key in
 * `googleReviewConfig.listingUrls`. The main's `reviewUrl` is never touched,
 * and a location the sub-account does not manage is refused. Real route, real
 * require-tenancy, real gate; Firestore in memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, LOC_NORTH, OTHER_SA, SA, mem, resetSync, seedExtraListing } from "@/test/gbp-sync-harness";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const SUB = `subAccounts/${SA}`;
const KEY = "e2e-velo-gqeberha-north";
const MAIN_URL = "https://g.page/r/e2e-existing/review";
const B_PROPOSED = "https://review.fixture.example/fake-gqeberha-north";
const B_OLD = "https://g.page/r/north-old/review";

function patchSub(patch: Record<string, unknown>) {
  mem.seed(SUB, { ...mem.read(SUB)!, ...patch });
}
function withBProposal(newReviewUri: string | null = B_PROPOSED) {
  const extras = mem.read(SUB)!.googleExtraListings as Array<Record<string, unknown>>;
  patchSub({ googleExtraListings: extras.map((l) => ({ ...l, newReviewUri })) });
}
function withConfig(over: Record<string, unknown> = {}) {
  patchSub({
    googleReviewConfig: {
      enabled: true, reviewUrl: MAIN_URL, channel: "sms", messageTemplate: "Hi {{reviewUrl}}", whatsappTemplateId: null,
      cooldownDays: 7, triggerOnQuotePaid: true, triggerOnDealCompleted: false, updatedAt: new Date("2026-09-01T00:00:00Z"), ...over,
    },
  });
}
const config = () => mem.read(SUB)?.googleReviewConfig as Record<string, unknown> | undefined;
const events = () => mem.list(`${SUB}/gbpEvents`).filter((e) => e.type === "review_url_adopted");

async function adopt(body: unknown, uid = "uid_admin") {
  const res = await POST(
    new Request(`http://127.0.0.1:3100/api/sub-accounts/${SA}/google-review/adopt-listing-url`, {
      method: "POST",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  resetSync();
  seedExtraListing(SA);
  withBProposal();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("an extra listing's link — its own key, compare-and-set", () => {
  it("adopts into listingUrls[locId]; the main reviewUrl and every other field untouched; audited with locationName", async () => {
    withConfig({ listingUrls: { "some-other": "https://g.page/r/other/review" } });
    const r = await adopt({ expectedCurrentUrl: null, locationName: LOC_NORTH });
    expect(r).toMatchObject({ status: 200, body: { ok: true, reviewUrl: B_PROPOSED } });
    expect(config()).toMatchObject({
      reviewUrl: MAIN_URL, enabled: true, channel: "sms", triggerOnQuotePaid: true,
      listingUrls: { "some-other": "https://g.page/r/other/review", [KEY]: B_PROPOSED },
    });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ locationName: LOC_NORTH, previousUrl: null, url: B_PROPOSED, actorUid: "uid_admin" });
  });

  it("replaces B's own adopted link when that is what the admin saw", async () => {
    withConfig({ listingUrls: { [KEY]: B_OLD } });
    expect((await adopt({ expectedCurrentUrl: B_OLD, locationName: LOC_NORTH })).status).toBe(200);
    expect(config()?.listingUrls).toEqual({ [KEY]: B_PROPOSED });
    expect(config()?.reviewUrl).toBe(MAIN_URL);
  });

  it("409 changed when B's link is not the one the admin saw — even if the MAIN's is", async () => {
    withConfig({ listingUrls: { [KEY]: B_OLD } });
    const before = config();
    const r = await adopt({ expectedCurrentUrl: MAIN_URL, locationName: LOC_NORTH });
    expect(r).toMatchObject({ status: 409, body: { code: "changed", currentUrl: B_OLD } });
    expect(config()).toEqual(before);
    expect(events()).toEqual([]);
  });

  it("409 changed when the admin saw nothing for B but a link was adopted since", async () => {
    withConfig({ listingUrls: { [KEY]: B_OLD } });
    expect(await adopt({ expectedCurrentUrl: null, locationName: LOC_NORTH })).toMatchObject({ status: 409, body: { code: "changed" } });
    expect(config()?.listingUrls).toEqual({ [KEY]: B_OLD });
  });

  it("with no config yet: creates one, auto-send OFF, main link empty, B's link under its key", async () => {
    expect((await adopt({ expectedCurrentUrl: null, locationName: LOC_NORTH })).status).toBe(200);
    expect(config()).toMatchObject({ enabled: false, reviewUrl: "", channel: "sms", listingUrls: { [KEY]: B_PROPOSED } });
  });

  it("409 no_proposal when B has no usable link — nothing written", async () => {
    withBProposal(null);
    withConfig();
    expect(await adopt({ expectedCurrentUrl: null, locationName: LOC_NORTH })).toMatchObject({ status: 409, body: { code: "no_proposal" } });
    expect(config()).not.toHaveProperty("listingUrls");
  });

  it("the main's locationName named explicitly is today's adopt: reviewUrl, not a key", async () => {
    patchSub({ googleListing: { ...(mem.read(SUB)!.googleListing as object), newReviewUri: "https://review.fixture.example/main" } });
    withConfig();
    expect((await adopt({ expectedCurrentUrl: MAIN_URL, locationName: LOC_A })).status).toBe(200);
    expect(config()?.reviewUrl).toBe("https://review.fixture.example/main");
    expect(config()).not.toHaveProperty("listingUrls");
  });
});

describe("membership", () => {
  it.each([
    ["a location this sub-account does not manage", "locations/not-ours"],
    ["another sub-account's extra", "locations/e2e-other-extra"],
  ])("400 unknown_listing for %s — nothing written", async (_l, loc) => {
    seedExtraListing(OTHER_SA, "locations/e2e-other-extra");
    withConfig();
    const before = config();
    expect(await adopt({ expectedCurrentUrl: null, locationName: loc })).toMatchObject({ status: 400, body: { code: "unknown_listing" } });
    expect(config()).toEqual(before);
    expect(events()).toEqual([]);
  });

  it("400 invalid_body for a non-string locationName", async () => {
    expect(await adopt({ expectedCurrentUrl: null, locationName: 5 })).toMatchObject({ status: 400, body: { code: "invalid_body" } });
  });

  it("403 for a collaborator — admin only, as for the main", async () => {
    withConfig();
    expect((await adopt({ expectedCurrentUrl: null, locationName: LOC_NORTH }, "uid_collab")).status).toBe(403);
    expect(config()).not.toHaveProperty("listingUrls");
  });
});
