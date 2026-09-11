import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/sub-accounts/[id]/google-review/adopt-listing-url — the ONLY
 * way the selected listing's review link becomes the configured one: an
 * explicit admin call, compare-and-set on the URL the admin saw. Real route,
 * real require-tenancy, real gate; Firestore in memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { DEFAULT_REVIEW_COOLDOWN_DAYS, DEFAULT_REVIEW_SMS_TEMPLATE } from "@/lib/reviews/constants";
import { syncListing } from "@/lib/gbp/sync/run";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const LISTING_URL = "https://review.fixture.example/fake-gqeberha";
const EXISTING = "https://g.page/r/e2e-existing/review";
const SUB = `subAccounts/${SA}`;

function patchSub(patch: Record<string, unknown>) {
  mem.seed(SUB, { ...mem.read(SUB)!, ...patch });
}
function withProposal(newReviewUri: string | null = LISTING_URL) {
  const sub = mem.read(SUB)!;
  patchSub({ googleListing: { ...(sub.googleListing as object), newReviewUri } });
}
function withConfig(over: Record<string, unknown> = {}) {
  patchSub({
    googleReviewConfig: {
      enabled: true, reviewUrl: EXISTING, channel: "whatsapp_manual", messageTemplate: "Hi {{reviewUrl}}",
      whatsappTemplateId: null, cooldownDays: 7, triggerOnQuotePaid: true, triggerOnDealCompleted: false,
      updatedAt: new Date("2026-09-01T00:00:00Z"), ...over,
    },
  });
}
const config = () => mem.read(SUB)?.googleReviewConfig as Record<string, unknown> | null | undefined;
const events = () => mem.list(`${SUB}/gbpEvents`).filter((e) => e.type === "review_url_adopted");

async function adopt(body: unknown, uid = "uid_admin") {
  const res = await POST(
    new Request(`http://127.0.0.1:3100/api/sub-accounts/${SA}/google-review/adopt-listing-url`, {
      method: "POST",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  resetSync();
  withProposal();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("adopting the listing's link", () => {
  it("with nothing configured, creates the config with the existing route's defaults — auto-send OFF", async () => {
    const r = await adopt({ expectedCurrentUrl: null });
    expect(r).toMatchObject({ status: 200, body: { ok: true, reviewUrl: LISTING_URL } });
    expect(config()).toMatchObject({
      enabled: false, reviewUrl: LISTING_URL, channel: "sms", messageTemplate: DEFAULT_REVIEW_SMS_TEMPLATE,
      whatsappTemplateId: null, cooldownDays: DEFAULT_REVIEW_COOLDOWN_DAYS, triggerOnQuotePaid: false, triggerOnDealCompleted: false,
    });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin", actorUid: "uid_admin", previousUrl: null, url: LISTING_URL,
    });
  });

  it("replaces a different configured URL when the admin saw that URL, and touches nothing else", async () => {
    withConfig();
    const r = await adopt({ expectedCurrentUrl: EXISTING });
    expect(r.status).toBe(200);
    expect(config()).toMatchObject({
      reviewUrl: LISTING_URL, enabled: true, channel: "whatsapp_manual", messageTemplate: "Hi {{reviewUrl}}",
      cooldownDays: 7, triggerOnQuotePaid: true,
    });
    expect(events()[0]).toMatchObject({ previousUrl: EXISTING, url: LISTING_URL });
  });
});

describe("compare-and-set — never a silent overwrite", () => {
  it("409 changed when the configured URL is not the one the admin saw — nothing written", async () => {
    withConfig({ reviewUrl: "https://g.page/r/changed-meanwhile/review" });
    const before = config();
    const r = await adopt({ expectedCurrentUrl: EXISTING });
    expect(r).toMatchObject({ status: 409, body: { code: "changed", currentUrl: "https://g.page/r/changed-meanwhile/review" } });
    expect(config()).toEqual(before);
    expect(events()).toEqual([]);
  });

  it("409 changed when the admin saw nothing configured but a URL has been saved since", async () => {
    withConfig();
    expect(await adopt({ expectedCurrentUrl: null })).toMatchObject({ status: 409, body: { code: "changed", currentUrl: EXISTING } });
    expect(config()?.reviewUrl).toBe(EXISTING);
  });

  it.each([
    ["no listing link", null],
    ["a listing link that is not https", "http://review.fixture.example/plain"],
  ])("409 no_proposal with %s — nothing written", async (_l, uri) => {
    withProposal(uri);
    withConfig();
    expect(await adopt({ expectedCurrentUrl: EXISTING })).toMatchObject({ status: 409, body: { code: "no_proposal" } });
    expect(config()?.reviewUrl).toBe(EXISTING);
    expect(events()).toEqual([]);
  });

  it("a sync never changes the configured URL, even with a different listing link on offer", async () => {
    withConfig();
    await syncListing(SA, { trigger: "scheduled" });
    expect(config()?.reviewUrl).toBe(EXISTING);
  });
});

describe("refusals", () => {
  it.each([
    ["a collaborator", "uid_collab"],
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of another sub-account", "uid_other_admin"],
  ])("403 for %s — nothing written", async (_l, uid) => {
    withConfig();
    expect((await adopt({ expectedCurrentUrl: EXISTING }, uid)).status).toBe(403);
    expect(config()?.reviewUrl).toBe(EXISTING);
    expect(events()).toEqual([]);
  });

  it("403 gate_off when the agency gate is off", async () => {
    patchSub({ googleEnabledByAgency: false });
    expect(await adopt({ expectedCurrentUrl: null })).toMatchObject({ status: 403, body: { code: "gate_off" } });
    expect(config()).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ["not JSON", "nope"],
    ["no expectedCurrentUrl", {}],
    ["a non-string expectedCurrentUrl", { expectedCurrentUrl: 5 }],
  ])("400 invalid_body on %s", async (_l, body) => {
    expect(await adopt(body)).toMatchObject({ status: 400, body: { code: "invalid_body" } });
    expect(config()).toBeUndefined();
  });
});
