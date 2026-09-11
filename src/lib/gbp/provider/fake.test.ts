import { describe, expect, it } from "vitest";

import { createFakeGbpProvider } from "./fake";
import { InMemoryScenarioStore, defaultFakeScenario } from "./fake-scenario";
import { GbpProviderError, type GbpReview } from "./types";

/**
 * The deterministic fake. It is what CI and local browser proof run through,
 * so it must honour the same contract as the real provider — typed errors,
 * pagination, and tokens that carry the sub-account they belong to.
 */

const SA = "sa_fake";

function setup() {
  const store = new InMemoryScenarioStore();
  return { store, fake: createFakeGbpProvider(store, SA) };
}

async function connected() {
  const ctx = setup();
  const tokens = await ctx.fake.exchangeCode(`fake-code:${SA}`, "http://127.0.0.1:3100/api/google/callback");
  return { ...ctx, tokens };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(GbpProviderError);
  return (e as GbpProviderError).kind;
}

describe("OAuth", () => {
  it("skips the Google hop: the consent URL is the callback with a fake code", () => {
    const { fake } = setup();
    const url = new URL(
      fake.authorizeUrl({ redirectUri: "http://127.0.0.1:3100/api/google/callback", state: "st.sig" }),
    );
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:3100/api/google/callback");
    expect(url.searchParams.get("code")).toBe(`fake-code:${SA}`);
    expect(url.searchParams.get("state")).toBe("st.sig");
  });

  it("mints its code for the sub-account it is bound to", () => {
    const { fake } = setup();
    const url = new URL(fake.authorizeUrl({ redirectUri: "http://127.0.0.1:3100/cb", state: "s" }));
    expect(url.searchParams.get("code")).toBe(`fake-code:${SA}`);
  });

  it("exchanges a fake code for tokens that encode the sub-account", async () => {
    const { tokens } = await connected();
    expect(tokens.refreshToken).toMatch(new RegExp(`^fake-refresh:${SA}:\\d+$`));
    expect(tokens.accessToken).toMatch(new RegExp(`^fake-access:${SA}:\\d+$`));
    expect(tokens.scopes).toEqual(["https://www.googleapis.com/auth/business.manage"]);
  });

  it("treats a non-fake code like Google treats a bad one: revoked", async () => {
    const { fake } = setup();
    expect(await kindOf(fake.exchangeCode("real-google-code", "x"))).toBe("revoked");
  });

  it("refreshes without rotation by default, and rotates when the scenario says so", async () => {
    const { fake, store, tokens } = await connected();
    const plain = await fake.refresh(tokens.refreshToken as string);
    expect(plain.refreshToken).toBeNull();
    expect(plain.accessToken).not.toBe(tokens.accessToken);

    await store.set(SA, { ...defaultFakeScenario(), rotateRefreshToken: true });
    const rotated = await fake.refresh(tokens.refreshToken as string);
    expect(rotated.refreshToken).toMatch(new RegExp(`^fake-refresh:${SA}:\\d+$`));
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
  });

  it("refuses to refresh once the scenario is revoked, and data calls then 401", async () => {
    const { fake, store, tokens } = await connected();
    await store.set(SA, { ...defaultFakeScenario(), revoked: true });
    expect(await kindOf(fake.refresh(tokens.refreshToken as string))).toBe("revoked");
    expect(await kindOf(fake.listAccounts(tokens.accessToken))).toBe("auth_expired");
  });
});

describe("default scenario", () => {
  it("has one account with two similarly named, distinguishable locations", async () => {
    const { fake, tokens } = await connected();
    const accounts = await fake.listAccounts(tokens.accessToken);
    expect(accounts.items).toHaveLength(1);
    expect(accounts.items[0].accountName).toBe("E2E Fixture Group");

    const locs = (await fake.listLocations(tokens.accessToken, accounts.items[0].name)).items;
    expect(locs.map((l) => l.title)).toEqual([
      "Velo Test Fibre — Gqeberha",
      "Velo Test Fibre — Gqeberha North",
    ]);
    expect(locs[0].address).not.toBe(locs[1].address);
    expect(locs[0].placeId).not.toBe(locs[1].placeId);
  });

  it("pages seven reviews in threes with the summary on every page", async () => {
    const { fake, tokens } = await connected();
    const accountName = (await fake.listAccounts(tokens.accessToken)).items[0].name;
    const locationName = (await fake.listLocations(tokens.accessToken, accountName)).items[0].name;

    const all: GbpReview[] = [];
    const sizes: number[] = [];
    let pageToken: string | undefined;
    do {
      const page = await fake.listReviews(tokens.accessToken, { accountName, locationName }, pageToken);
      expect(page.totalReviewCount).toBe(7);
      expect(page.averageRating).toBeCloseTo(3.6, 5);
      sizes.push(page.reviews.length);
      all.push(...page.reviews);
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    expect(sizes).toEqual([3, 3, 1]);
    expect(new Set(all.map((r) => r.reviewId)).size).toBe(7);
    expect(all.some((r) => r.starRating === 1)).toBe(true);
    expect(all.some((r) => r.reply === null)).toBe(true);
    expect(all.some((r) => r.comment?.includes("(Translated by Google)") && r.comment.includes("(Original)"))).toBe(true);
    // Every review lives under the location's v4 path.
    expect(all.every((r) => r.name.startsWith(`${accountName}/${locationName}/reviews/`))).toBe(true);
  });

  it("answers not_found for a location outside the account", async () => {
    const { fake, tokens } = await connected();
    const accountName = (await fake.listAccounts(tokens.accessToken)).items[0].name;
    expect(
      await kindOf(fake.listReviews(tokens.accessToken, { accountName, locationName: "locations/not-there" })),
    ).toBe("not_found");
    expect(await kindOf(fake.listLocations(tokens.accessToken, "accounts/not-mine"))).toBe("not_found");
  });
});

describe("scenario controls", () => {
  it("fails the next matching call once, then recovers", async () => {
    const { fake, store, tokens } = await connected();
    await store.set(SA, { ...defaultFakeScenario(), failNext: { op: "listAccounts", kind: "rate_limited" } });
    expect(await kindOf(fake.listAccounts(tokens.accessToken))).toBe("rate_limited");
    expect((await fake.listAccounts(tokens.accessToken)).items).toHaveLength(1);
  });

  it("fails one reviews page a set number of times, leaving the other pages alone", async () => {
    const { fake, store, tokens } = await connected();
    await store.set(SA, {
      ...defaultFakeScenario(),
      failReviewsPage: { pageToken: "3", kind: "transient", times: 2 },
    });
    const ref = { accountName: "accounts/e2e-fixture-group", locationName: "locations/e2e-velo-gqeberha" };
    expect((await fake.listReviews(tokens.accessToken, ref)).reviews).toHaveLength(3);
    expect(await kindOf(fake.listReviews(tokens.accessToken, ref, "3"))).toBe("transient");
    expect(await kindOf(fake.listReviews(tokens.accessToken, ref, "3"))).toBe("transient");
    expect((await fake.listReviews(tokens.accessToken, ref, "3")).reviews).toHaveLength(3);
    expect((await store.get(SA))?.failReviewsPage).toBeUndefined();
  });

  it("can report rating and count on the first reviews page only", async () => {
    const { fake, store, tokens } = await connected();
    await store.set(SA, { ...defaultFakeScenario(), summaryOnFirstPageOnly: true });
    const ref = { accountName: "accounts/e2e-fixture-group", locationName: "locations/e2e-velo-gqeberha" };
    expect(await fake.listReviews(tokens.accessToken, ref)).toMatchObject({ averageRating: 3.6, totalReviewCount: 7 });
    expect(await fake.listReviews(tokens.accessToken, ref, "3")).toMatchObject({ averageRating: null, totalReviewCount: null });
  });

  it("fails the FIRST reviews page when pageToken is null, and forever without times", async () => {
    const { fake, store, tokens } = await connected();
    await store.set(SA, { ...defaultFakeScenario(), failReviewsPage: { pageToken: null, kind: "permission_denied" } });
    const ref = { accountName: "accounts/e2e-fixture-group", locationName: "locations/e2e-velo-gqeberha" };
    for (let i = 0; i < 4; i++) expect(await kindOf(fake.listReviews(tokens.accessToken, ref))).toBe("permission_denied");
    expect((await fake.listReviews(tokens.accessToken, ref, "3")).reviews).toHaveLength(3);
  });

  it("persists a reply and its deletion", async () => {
    const { fake, tokens } = await connected();
    const accountName = (await fake.listAccounts(tokens.accessToken)).items[0].name;
    const locationName = (await fake.listLocations(tokens.accessToken, accountName)).items[0].name;
    const first = await fake.listReviews(tokens.accessToken, { accountName, locationName });
    const target = first.reviews.find((r) => r.reply === null) as GbpReview;

    const reply = await fake.putReply(tokens.accessToken, target.name, "Thanks from the fixture");
    expect(reply.comment).toBe("Thanks from the fixture");
    const again = await fake.listReviews(tokens.accessToken, { accountName, locationName });
    expect(again.reviews.find((r) => r.name === target.name)?.reply?.comment).toBe("Thanks from the fixture");

    await fake.deleteReply(tokens.accessToken, target.name);
    const after = await fake.listReviews(tokens.accessToken, { accountName, locationName });
    expect(after.reviews.find((r) => r.name === target.name)?.reply).toBeNull();
  });

  it("rejects an access token that is not a fake one", async () => {
    const { fake } = setup();
    expect(await kindOf(fake.listAccounts("ya29.real-google-token"))).toBe("auth_expired");
  });
});

describe("binding to the fenced sub-account", () => {
  const OTHER = "sa_real_client";

  /** A store that records every sub-account id it is asked about. */
  function spiedSetup() {
    const store = new InMemoryScenarioStore();
    const touched: string[] = [];
    const spied = {
      get: (id: string) => (touched.push(id), store.get(id)),
      set: (id: string, s: Parameters<typeof store.set>[1]) => (touched.push(id), store.set(id, s)),
    };
    return { touched, fake: createFakeGbpProvider(spied, SA) };
  }

  it("refuses a code, refresh token, access token or revoke naming another sub-account", async () => {
    const { fake, touched } = spiedSetup();
    expect(await kindOf(fake.exchangeCode(`fake-code:${OTHER}`, "x"))).toBe("revoked");
    expect(await kindOf(fake.refresh(`fake-refresh:${OTHER}:1`))).toBe("revoked");
    expect(await kindOf(fake.revoke(`fake-refresh:${OTHER}:1`))).toBe("revoked");
    expect(await kindOf(fake.listAccounts(`fake-access:${OTHER}:1`))).toBe("auth_expired");
    expect(await kindOf(fake.putReply(`fake-access:${OTHER}:1`, "accounts/a/locations/l/reviews/r", "x"))).toBe(
      "auth_expired",
    );
    // Nothing outside the bound sub-account was ever read or written.
    expect(touched.filter((id) => id !== SA)).toEqual([]);
  });

  it("only ever loads and saves the bound sub-account's scenario", async () => {
    const { fake, touched } = spiedSetup();
    const tokens = await fake.exchangeCode(`fake-code:${SA}`, "x");
    await fake.listAccounts(tokens.accessToken);
    await fake.refresh(tokens.refreshToken as string);
    expect(touched.length).toBeGreaterThan(0);
    expect(new Set(touched)).toEqual(new Set([SA]));
  });
});
