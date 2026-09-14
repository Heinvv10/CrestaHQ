import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/public/gbp/feed/[publicId] — WHAT the public feed says: the exact
 * selected public data, deterministic order, every rating (no review
 * gating), the non-enumerating 404, and what a disconnect / listing clear
 * leaves behind. Real sync (fake provider) → real widget route → real feed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { ACCOUNT, LOC_A, OTHER_SA, SA, asUser, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { VELO, createWidget, feed, feedBody, freshIp } from "@/test/gbp-feed-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { syncListing } from "@/lib/gbp/sync/run";
import { reviewDocId } from "@/lib/gbp/sync/store";
import { DELETE as disconnect } from "@/app/api/sub-accounts/[id]/google/route";
import { DELETE as clearListingRoute } from "@/app/api/sub-accounts/[id]/google/listing/route";
import { DELETE as revokeRoute, PUT as putWidget } from "@/app/api/sub-accounts/[id]/gbp/widget/route";
import { POST as rotateRoute } from "@/app/api/sub-accounts/[id]/gbp/widget/rotate/route";

const ORIGINAL = { ...process.env };
const TRANSLATED =
  "(Translated by Google) Fixture review: the connection is okay.\n\n(Original)\nFixture-resensie: die verbinding is okay.";
const docId = (id: string) => reviewDocId(`${ACCOUNT}/${LOC_A}/reviews/${id}`);
const admin = (path: string, method: string, body?: unknown) =>
  asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}${path}`, "uid_admin", method, body === undefined ? undefined : JSON.stringify(body));
const params = { params: Promise.resolve({ id: SA }) };
let ip: string;

beforeEach(async () => {
  resetSync();
  ip = freshIp();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const sub = mem.read(`subAccounts/${SA}`)!;
  mem.seed(`subAccounts/${SA}`, {
    ...sub,
    googleListing: {
      ...(sub.googleListing as object),
      mapsUri: "https://maps.google.com/?cid=123",
      newReviewUri: "https://search.google.com/local/writereview?placeid=abc",
    },
  });
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("an enabled widget returns exactly the selected public data", () => {
  it("serves listing, rating, source, freshness and every active review, byte-exact", async () => {
    const id = await createWidget();
    const body = await feedBody(id, { "x-forwarded-for": ip });
    expect(body).toEqual({
      version: 1,
      status: "ok",
      listing: {
        title: "Velo Test Fibre — Gqeberha",
        mapsUri: "https://maps.google.com/?cid=123",
        writeReviewUri: "https://search.google.com/local/writereview?placeid=abc",
      },
      rating: { average: 3.6, count: 7 },
      source: { name: "Google", attribution: "Reviews from Google" },
      display: { layout: "carousel", theme: "light" },
      freshness: { lastSuccessfulSyncAt: expect.any(String), stale: false, generatedAt: expect.any(String) },
      reviews: expect.any(Array),
    });
    expect(Date.now() - Date.parse(body.freshness.lastSuccessfulSyncAt!)).toBeLessThan(60_000);

    expect(body.reviews[0]).toEqual({
      id: docId("fake-r7"),
      author: { name: "Fixture Reviewer fake-r7", photoUrl: null, anonymous: false },
      rating: 5,
      text: "Fixture review: installed on the day promised.",
      createdAt: "2026-08-27T09:00:00.000Z",
      updatedAt: "2026-08-27T09:00:00.000Z",
      reply: { text: "Thank you from the fixture team.", updatedAt: "2026-08-27T12:00:00.000Z" },
    });
    const byId = new Map(body.reviews.map((r) => [r.id, r]));
    expect(byId.get(docId("fake-r5"))?.text).toBe(TRANSLATED);
    expect(byId.get(docId("fake-r1"))?.text).toBe("  Fixture review with leading and trailing spaces.  ");
    expect(byId.get(docId("fake-r3"))).toMatchObject({ text: null, reply: { text: "Thanks for the stars, fixture reviewer." } });
    expect(byId.get(docId("fake-r4"))?.author).toEqual({ name: "", photoUrl: null, anonymous: true });
  });

  it("orders newest first by createTime and never filters by rating — the 1-star review is there", async () => {
    const body = await feedBody(await createWidget(), { "x-forwarded-for": ip });
    expect(body.reviews.map((r) => r.id)).toEqual(
      ["fake-r7", "fake-r6", "fake-r5", "fake-r4", "fake-r3", "fake-r2", "fake-r1"].map(docId),
    );
    expect(body.reviews.map((r) => r.rating)).toEqual([5, 2, 3, 5, 4, 1, 5]);
  });

  it("breaks a createTime tie by id, and serves only the first maxReviews", async () => {
    const tie = new Date("2026-09-01T08:00:00Z");
    for (const id of ["zzz", "aaa", "mmm"]) {
      mem.seed(`subAccounts/${SA}/gbpReviews/${id}`, {
        subAccountId: SA, locationName: LOC_A, state: "active", starRating: 1, comment: id,
        reviewer: { displayName: id, profilePhotoUrl: null, isAnonymous: false },
        createTime: tie, updateTime: tie, reply: null, lastSeenAt: new Date(),
      });
    }
    const id = await createWidget({ enabled: true, allowedOrigins: [VELO], maxReviews: 4 });
    const first = await feedBody(id, { "x-forwarded-for": ip });
    expect(first.reviews.map((r) => r.id)).toEqual(["aaa", "mmm", "zzz", docId("fake-r7")]);
    expect((await feedBody(id, { "x-forwarded-for": ip })).reviews.map((r) => r.id)).toEqual(first.reviews.map((r) => r.id));
  });

  it("serves only active reviews of the current listing", async () => {
    const path = `subAccounts/${SA}/gbpReviews/${docId("fake-r6")}`;
    mem.seed(path, { ...mem.read(path)!, state: "removed", comment: null, reviewer: null, starRating: null });
    mem.seed(`subAccounts/${SA}/gbpReviews/other`, {
      ...mem.read(`subAccounts/${SA}/gbpReviews/${docId("fake-r7")}`)!, locationName: "locations/other",
      createTime: new Date("2026-09-05T00:00:00Z"),
    });
    const ids = (await feedBody(await createWidget(), { "x-forwarded-for": ip })).reviews.map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain(docId("fake-r6"));
    expect(ids).not.toContain("other");
  });

  it("has an honest no-review state: a listing Google reports empty is ok, empty, with no invented rating", async () => {
    // Not "sync an existing listing down to zero": PR 2 tombstones a cached review only after TWO
    // missed complete passes, and a pass that sees nothing while removals are due is braked as an
    // outage. A listing with no reviews is one Google reports empty from its first sync — here the
    // second fixture sub-account, never synced before.
    setScenario(OTHER_SA, (s) => void (s.reviews[LOC_A] = { averageRating: null, totalReviewCount: 0, reviews: [] }));
    expect((await syncListing(OTHER_SA, { trigger: "manual" })).status).toBe("success");
    const other = await createWidget({ enabled: true, allowedOrigins: [VELO] }, OTHER_SA, "uid_other_admin");
    expect(await feedBody(other, { "x-forwarded-for": ip })).toMatchObject({
      status: "ok", rating: null, reviews: [], freshness: { stale: false },
    });
  });
});

describe("unknown, malformed, disabled and revoked ids are the SAME 404", () => {
  async function snapshot(res: Response) {
    return {
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type"),
      cache: res.headers.get("cache-control"),
      acao: res.headers.get("access-control-allow-origin"),
    };
  }

  it("says not_found, byte-identical, no-store, no CORS grant — even to an allowed Origin", async () => {
    const live = await createWidget();
    const disabled = await createWidget({ enabled: false, allowedOrigins: [VELO] }, "sa_2", "uid_other_admin");
    const h = { "x-forwarded-for": ip, origin: VELO };
    const unknown = await snapshot(await feed("A".repeat(32), h));
    expect(unknown).toEqual({
      status: 404, text: '{"error":"not_found"}', type: "application/json", cache: "no-store", acao: null,
    });
    expect(await snapshot(await feed("../etc/passwd", h))).toEqual(unknown);
    expect(await snapshot(await feed("short", h))).toEqual(unknown);
    expect(await snapshot(await feed(disabled, h))).toEqual(unknown);
    // An identity header is untrusted on a public path and changes nothing.
    expect(await snapshot(await feed(disabled, { ...h, "x-user-uid": "uid_other_admin" }))).toEqual(unknown);

    const res = await rotateRoute(admin("/gbp/widget/rotate", "POST"), params);
    const rotated = ((await res.json()) as { widget: { publicId: string } }).widget.publicId;
    expect(await snapshot(await feed(live, h))).toEqual(unknown);
    expect((await feed(rotated, h)).status).toBe(200);

    await revokeRoute(admin("/gbp/widget", "DELETE"), params);
    expect(await snapshot(await feed(rotated, h))).toEqual(unknown);
  });

  it("never lets a malformed id reach Firestore as a path", async () => {
    const doc = vi.spyOn(storeDb, "doc");
    for (const bad of ["../etc/passwd", "a/b", "A".repeat(31), "A".repeat(33), "A".repeat(31) + "="]) {
      expect((await feed(bad, { "x-forwarded-for": ip })).status).toBe(404);
    }
    expect(doc.mock.calls.filter(([path]) => String(path).startsWith("gbpWidgets"))).toEqual([]);
  });

  it("a widget switched off 404s, and switched back on serves again", async () => {
    const id = await createWidget();
    await putWidget(admin("/gbp/widget", "PUT", { enabled: false, allowedOrigins: [VELO] }), params);
    expect((await feed(id, { "x-forwarded-for": ip })).status).toBe(404);
    await putWidget(admin("/gbp/widget", "PUT", { enabled: true, allowedOrigins: [VELO] }), params);
    expect((await feed(id, { "x-forwarded-for": ip })).status).toBe(200);
  });

  it("an archived sub-account counts as disabled", async () => {
    const id = await createWidget();
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, status: "archived" });
    const res = await feed(id, { "x-forwarded-for": ip });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"not_found"}');
  });

  it("the agency gate off counts as disabled", async () => {
    const id = await createWidget();
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleEnabledByAgency: false });
    const res = await feed(id, { "x-forwarded-for": ip });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"not_found"}');
  });
});

describe("disconnect and listing clears leave the feed honest", () => {
  const unavailable = { status: "unavailable", listing: null, rating: null, reviews: [] };

  it("after a disconnect the feed reports unavailable, and the widget config survives", async () => {
    const id = await createWidget();
    expect((await disconnect(admin("/google", "DELETE"), params)).status).toBe(200);
    expect(await feedBody(id, { "x-forwarded-for": ip })).toMatchObject(unavailable);
    expect(mem.read(`subAccounts/${SA}`)?.gbpWidgetMeta).toMatchObject({ publicId: id, enabled: true });
  });

  it("after the listing is cleared the feed reports unavailable", async () => {
    const id = await createWidget();
    expect((await clearListingRoute(admin("/google/listing", "DELETE"), params)).status).toBe(200);
    expect(await feedBody(id, { "x-forwarded-for": ip })).toMatchObject(unavailable);
  });
});
