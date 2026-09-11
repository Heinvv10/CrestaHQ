import "server-only";

import { GOOGLE_SCOPE, type GoogleTokens } from "@/lib/google/oauth";
import {
  defaultFakeScenario,
  type FakeOp,
  type FakeScenario,
  type FakeScenarioStore,
} from "./fake-scenario";
import { GbpProviderError, type GbpPage, type GbpProvider, type GbpReview } from "./types";

/**
 * Deterministic stand-in for Google, driven by a {@link FakeScenarioStore}.
 * Reachable only through `getGbpProviderFor` in select.ts, which refuses it
 * outside loopback dev/CI and outside the fixture agency.
 *
 * Tokens encode the sub-account (`fake-refresh:{sa}:{n}` /
 * `fake-access:{sa}:{n}`) so every data call can find its scenario without a
 * side channel. Lists page in threes so callers must really paginate.
 */

const PAGE = 3;
const ACCESS_RE = /^fake-access:(.+):(\d+)$/;
const REFRESH_RE = /^fake-refresh:(.+):(\d+)$/;
const CODE_RE = /^fake-code:(.+)$/;

function page<T>(items: T[], pageToken?: string): { slice: T[]; next: string | null } {
  const start = pageToken ? Number(pageToken) : 0;
  if (!Number.isInteger(start) || start < 0 || start > items.length) {
    throw new GbpProviderError("malformed", { status: 400 });
  }
  const end = start + PAGE;
  return { slice: items.slice(start, end), next: end < items.length ? String(end) : null };
}

function asPage<T>(items: T[], pageToken?: string): GbpPage<T> {
  const { slice, next } = page(items, pageToken);
  return { items: slice, nextPageToken: next };
}

export function createFakeGbpProvider(store: FakeScenarioStore): GbpProvider {
  let counter = 0;

  async function load(subAccountId: string): Promise<FakeScenario> {
    return (await store.get(subAccountId)) ?? defaultFakeScenario();
  }

  /** Throw the scripted failure for `op` once, persisting that it was used. */
  async function consume(subAccountId: string, scenario: FakeScenario, op: FakeOp) {
    if (scenario.failNext?.op !== op) return;
    const { kind } = scenario.failNext;
    delete scenario.failNext;
    await store.set(subAccountId, scenario);
    throw new GbpProviderError(kind);
  }

  function mint(subAccountId: string, withRefresh: boolean): GoogleTokens {
    counter += 1;
    return {
      accessToken: `fake-access:${subAccountId}:${counter}`,
      refreshToken: withRefresh ? `fake-refresh:${subAccountId}:${counter}` : null,
      expiresAt: Date.now() + 3600_000,
      scopes: [GOOGLE_SCOPE],
    };
  }

  /** Resolve an access token to its scenario, like Google resolving a bearer. */
  async function authed(accessToken: string, op: FakeOp) {
    const m = ACCESS_RE.exec(accessToken);
    if (!m) throw new GbpProviderError("auth_expired", { status: 401 });
    const subAccountId = m[1];
    const scenario = await load(subAccountId);
    await consume(subAccountId, scenario, op);
    // Revoking a grant at Google kills its access tokens too.
    if (scenario.revoked) throw new GbpProviderError("auth_expired", { status: 401 });
    return { subAccountId, scenario };
  }

  function findReview(scenario: FakeScenario, reviewName: string): GbpReview {
    for (const entry of Object.values(scenario.reviews)) {
      const hit = entry.reviews.find((r) => r.name === reviewName);
      if (hit) return hit;
    }
    throw new GbpProviderError("not_found", { status: 404 });
  }

  return {
    authorizeUrl({ redirectUri, state, subAccountId }) {
      const url = new URL(redirectUri);
      url.searchParams.set("code", `fake-code:${subAccountId}`);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code) {
      const m = CODE_RE.exec(code);
      if (!m) throw new GbpProviderError("revoked", { status: 400 });
      await consume(m[1], await load(m[1]), "exchangeCode");
      return mint(m[1], true);
    },

    async refresh(refreshToken) {
      const m = REFRESH_RE.exec(refreshToken);
      if (!m) throw new GbpProviderError("revoked", { status: 400 });
      const scenario = await load(m[1]);
      await consume(m[1], scenario, "refresh");
      if (scenario.revoked) throw new GbpProviderError("revoked", { status: 400 });
      return mint(m[1], !!scenario.rotateRefreshToken);
    },

    async revoke(token) {
      const m = REFRESH_RE.exec(token) ?? ACCESS_RE.exec(token);
      if (m) await consume(m[1], await load(m[1]), "revoke");
    },

    async listAccounts(accessToken, pageToken) {
      const { scenario } = await authed(accessToken, "listAccounts");
      return asPage(scenario.accounts, pageToken);
    },

    async listLocations(accessToken, accountName, pageToken) {
      const { scenario } = await authed(accessToken, "listLocations");
      if (!scenario.accounts.some((a) => a.name === accountName)) {
        throw new GbpProviderError("not_found", { status: 404 });
      }
      return asPage(scenario.locations[accountName] ?? [], pageToken);
    },

    async listReviews(accessToken, { accountName, locationName }, pageToken) {
      const { scenario } = await authed(accessToken, "listReviews");
      const owned = scenario.locations[accountName] ?? [];
      if (!owned.some((l) => l.name === locationName)) {
        throw new GbpProviderError("not_found", { status: 404 });
      }
      const entry = scenario.reviews[locationName] ?? {
        averageRating: null,
        totalReviewCount: 0,
        reviews: [],
      };
      const { slice, next } = page(entry.reviews, pageToken);
      return {
        reviews: slice,
        averageRating: entry.averageRating,
        totalReviewCount: entry.totalReviewCount,
        nextPageToken: next,
      };
    },

    async putReply(accessToken, reviewName, comment) {
      const { subAccountId, scenario } = await authed(accessToken, "putReply");
      const target = findReview(scenario, reviewName);
      target.reply = { comment, updateTime: new Date().toISOString() };
      await store.set(subAccountId, scenario);
      return target.reply;
    },

    async deleteReply(accessToken, reviewName) {
      const { subAccountId, scenario } = await authed(accessToken, "deleteReply");
      findReview(scenario, reviewName).reply = null;
      await store.set(subAccountId, scenario);
    },
  };
}
