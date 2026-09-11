import { afterEach, describe, expect, it, vi } from "vitest";

import { googleGbpProvider as g } from "./google";
import { GbpProviderError } from "./types";

/**
 * The real Google HTTP implementation, with only `fetch` stubbed. Endpoints
 * were checked against developers.google.com on 2026-09-11; the URL
 * assertions below pin them so a silent version or host drift goes red.
 */

const TOKEN = "ya29.DataAccessToken";

type Call = [string, RequestInit];
function stub(...responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const queue = [...responses];
  const spy = vi.fn(async (_url: string, _init: RequestInit) => {
    const r = queue.shift() ?? { body: {} };
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  });
  vi.stubGlobal("fetch", spy);
  return spy as unknown as { mock: { calls: Call[] } };
}

async function errOf(p: Promise<unknown>): Promise<GbpProviderError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GbpProviderError);
  return e as GbpProviderError;
}

afterEach(() => vi.unstubAllGlobals());

const REVIEW = {
  name: "accounts/111/locations/222/reviews/r1",
  reviewId: "r1",
  reviewer: { displayName: "Test Reviewer", profilePhotoUrl: "https://example.test/p.png" },
  starRating: "FOUR",
  comment: "  Great install \n(Translated by Google) Good\n\n(Original)\nGoed  ",
  createTime: "2026-09-01T10:00:00Z",
  updateTime: "2026-09-02T10:00:00Z",
  reviewReply: { comment: "Thanks!", updateTime: "2026-09-03T10:00:00Z" },
};

describe("listAccounts", () => {
  it("calls Account Management v1 with the bearer token and pages", async () => {
    const spy = stub({
      body: {
        accounts: [{ name: "accounts/111", accountName: "Test Group", type: "LOCATION_GROUP" }],
        nextPageToken: "p2",
      },
    });
    const page = await g.listAccounts(TOKEN, "p1");
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20&pageToken=p1",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(page).toEqual({
      items: [{ name: "accounts/111", accountName: "Test Group", type: "LOCATION_GROUP" }],
      nextPageToken: "p2",
    });
  });

  it("treats an absent accounts array as empty and no token as the last page", async () => {
    stub({ body: {} });
    expect(await g.listAccounts(TOKEN)).toEqual({ items: [], nextPageToken: null });
  });
});

describe("listLocations", () => {
  it("sends the REQUIRED readMask and maps metadata as display data", async () => {
    const spy = stub({
      body: {
        locations: [
          {
            name: "locations/222",
            title: "Test Fibre",
            storefrontAddress: { addressLines: ["1 Test St", "Unit 2"], locality: "Testville", postalCode: "0001" },
            websiteUri: "https://example.test",
            metadata: { placeId: "ChIJtest", mapsUri: "https://maps.example/x", newReviewUri: "https://g.example/r" },
          },
          { name: "locations/333", title: "Service Area Only" },
        ],
      },
    });
    const page = await g.listLocations(TOKEN, "accounts/111");
    expect(spy.mock.calls[0][0]).toBe(
      "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations" +
        "?readMask=name%2Ctitle%2CstorefrontAddress%2CwebsiteUri%2Cmetadata&pageSize=100",
    );
    expect(page.items[0]).toEqual({
      name: "locations/222",
      title: "Test Fibre",
      address: "1 Test St, Unit 2, Testville, 0001",
      websiteUri: "https://example.test",
      placeId: "ChIJtest",
      mapsUri: "https://maps.example/x",
      newReviewUri: "https://g.example/r",
    });
    expect(page.items[1]).toMatchObject({ address: "", websiteUri: null, placeId: null });
  });

  it("refuses an account name that is not accounts/{id}", async () => {
    stub();
    await expect(g.listLocations(TOKEN, "accounts/1/../x")).rejects.toThrow();
  });
});

describe("listReviews", () => {
  it("composes the v4 path from accounts/{a} + locations/{l}", async () => {
    const spy = stub({
      body: { reviews: [REVIEW], averageRating: 4.3, totalReviewCount: 7, nextPageToken: "n2" },
    });
    const page = await g.listReviews(TOKEN, { accountName: "accounts/111", locationName: "locations/222" }, "n1");
    expect(spy.mock.calls[0][0]).toBe(
      "https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews" +
        "?pageSize=50&orderBy=updateTime%20desc&pageToken=n1",
    );
    expect(page.averageRating).toBe(4.3);
    expect(page.totalReviewCount).toBe(7);
    expect(page.nextPageToken).toBe("n2");
  });

  it("maps a review with the comment byte-exact and the reply attached", async () => {
    stub({ body: { reviews: [REVIEW], averageRating: 4, totalReviewCount: 1 } });
    const [r] = (await g.listReviews(TOKEN, { accountName: "accounts/111", locationName: "locations/222" })).reviews;
    expect(r).toEqual({
      name: "accounts/111/locations/222/reviews/r1",
      reviewId: "r1",
      reviewer: { displayName: "Test Reviewer", profilePhotoUrl: "https://example.test/p.png", isAnonymous: false },
      starRating: 4,
      comment: REVIEW.comment,
      createTime: "2026-09-01T10:00:00Z",
      updateTime: "2026-09-02T10:00:00Z",
      reply: { comment: "Thanks!", updateTime: "2026-09-03T10:00:00Z" },
    });
  });

  it("maps every star enum and leaves absent comment/reply as null", async () => {
    const stars = ["ONE", "TWO", "THREE", "FOUR", "FIVE"];
    stub({
      body: {
        reviews: stars.map((s, i) => ({ ...REVIEW, reviewId: `r${i}`, starRating: s, comment: undefined, reviewReply: undefined })),
      },
    });
    const page = await g.listReviews(TOKEN, { accountName: "accounts/111", locationName: "locations/222" });
    expect(page.reviews.map((r) => r.starRating)).toEqual([1, 2, 3, 4, 5]);
    expect(page.reviews.every((r) => r.comment === null && r.reply === null)).toBe(true);
    expect(page.averageRating).toBeNull();
    expect(page.totalReviewCount).toBeNull();
  });

  it("fails closed on STAR_RATING_UNSPECIFIED or a missing id", async () => {
    const ref = { accountName: "accounts/111", locationName: "locations/222" };
    stub({ body: { reviews: [{ ...REVIEW, starRating: "STAR_RATING_UNSPECIFIED" }] } });
    expect((await errOf(g.listReviews(TOKEN, ref))).kind).toBe("malformed");
    stub({ body: { reviews: [{ ...REVIEW, reviewId: undefined }] } });
    expect((await errOf(g.listReviews(TOKEN, ref))).kind).toBe("malformed");
    stub({ body: { reviews: "nope" } });
    expect((await errOf(g.listReviews(TOKEN, ref))).kind).toBe("malformed");
  });
});

describe("replies", () => {
  it("PUTs {comment} to {review.name}/reply", async () => {
    const spy = stub({ body: { comment: "Thank you", updateTime: "2026-09-04T00:00:00Z" } });
    const reply = await g.putReply(TOKEN, REVIEW.name, "Thank you");
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews/r1/reply");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ comment: "Thank you" });
    expect(reply).toEqual({ comment: "Thank you", updateTime: "2026-09-04T00:00:00Z" });
  });

  it("DELETEs the same path", async () => {
    const spy = stub({ body: {} });
    await g.deleteReply(TOKEN, REVIEW.name);
    expect(spy.mock.calls[0][0]).toBe(
      "https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews/r1/reply",
    );
    expect(spy.mock.calls[0][1].method).toBe("DELETE");
  });

  it("refuses a review name that is not a v4 review path", async () => {
    stub();
    await expect(g.putReply(TOKEN, "locations/222/reviews/r1", "x")).rejects.toThrow();
  });
});

describe("status mapping", () => {
  const call = () => g.listAccounts(TOKEN);

  it.each([
    [401, {}, "auth_expired"],
    [403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, "insufficient_scope"],
    [403, { error: { message: "Request had insufficient authentication scopes." } }, "insufficient_scope"],
    [403, { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } }, "permission_denied"],
    [404, {}, "not_found"],
    [500, {}, "transient"],
    [503, {}, "transient"],
  ])("HTTP %i → %s", async (status, body, kind) => {
    stub({ status, body });
    const e = await errOf(call());
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
  });

  it("parses Retry-After seconds on 429", async () => {
    stub({ status: 429, body: {}, headers: { "Retry-After": "7" } });
    const e = await errOf(call());
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(7000);
  });

  it("maps a network throw to transient and non-JSON to malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await errOf(call())).kind).toBe("transient");
    stub({ body: "<html>gateway</html>" });
    expect((await errOf(call())).kind).toBe("malformed");
  });

  it("never leaks the body, the token or the URL query into the message", async () => {
    stub({ status: 403, body: { error: { message: `LEAKY-DETAIL ${TOKEN}` } } });
    const e = await errOf(g.listAccounts(TOKEN, "SECRET-PAGE-TOKEN"));
    expect(e.message).not.toContain("LEAKY-DETAIL");
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain("SECRET-PAGE-TOKEN");
  });
});

describe("body read failure", () => {
  it("is transient, never an empty success page", async () => {
    const broken = new Response(
      new ReadableStream({ start(c) { c.error(new Error("socket closed")); } }),
      { status: 200 },
    );
    vi.stubGlobal("fetch", vi.fn(async () => broken));
    const e = await errOf(g.listAccounts(TOKEN));
    expect(e.kind).toBe("transient");
  });
});
