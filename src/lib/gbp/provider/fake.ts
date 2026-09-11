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
 * Each instance is BOUND to the one sub-account select.ts fenced. Codes and
 * tokens still encode a sub-account (`fake-code:{sa}`, `fake-refresh:{sa}:{n}`,
 * `fake-access:{sa}:{n}`), but one naming any other sub-account is refused
 * like Google refuses a foreign credential — and the scenario store is only
 * ever read or written for the bound id. Without the binding, a valid state
 * for the fixture plus `code=fake-code:<real tenant>` would have pointed the
 * fixture's tokens (and every later scenario write) at the real tenant.
 * Lists page in threes so callers must really paginate.
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

/** Token counter shared by every instance so tokens stay unique per process. */
let counter = 0;

export function createFakeGbpProvider(
  store: FakeScenarioStore,
  bound: string,
): GbpProvider {
  /** True only when `value` matches `re` AND names the bound sub-account. */
  const mine = (re: RegExp, value: string) => re.exec(value)?.[1] === bound;

  async function load(): Promise<FakeScenario> {
    return (await store.get(bound)) ?? defaultFakeScenario();
  }

  /** Throw the scripted failure for `op` once, persisting that it was used. */
  async function consume(scenario: FakeScenario, op: FakeOp) {
    if (scenario.failNext?.op !== op) return;
    const { kind } = scenario.failNext;
    delete scenario.failNext;
    await store.set(bound, scenario);
    throw new GbpProviderError(kind);
  }

  function mint(withRefresh: boolean): GoogleTokens {
    counter += 1;
    return {
      accessToken: `fake-access:${bound}:${counter}`,
      refreshToken: withRefresh ? `fake-refresh:${bound}:${counter}` : null,
      expiresAt: Date.now() + 3600_000,
      scopes: [GOOGLE_SCOPE],
    };
  }

  /** Resolve an access token to its scenario, like Google resolving a bearer. */
  async function authed(accessToken: string, op: FakeOp) {
    if (!mine(ACCESS_RE, accessToken)) {
      throw new GbpProviderError("auth_expired", { status: 401 });
    }
    const scenario = await load();
    await consume(scenario, op);
    // Revoking a grant at Google kills its access tokens too.
    if (scenario.revoked) throw new GbpProviderError("auth_expired", { status: 401 });
    return scenario;
  }

  /** Append a reply call to the scenario's log BEFORE anything can fail — a failed call is still a call. */
  async function logCall(op: "putReply" | "deleteReply", reviewName: string) {
    const scenario = await load();
    scenario.calls = [...(scenario.calls ?? []), { op, reviewName }];
    await store.set(bound, scenario);
  }

  function findReview(scenario: FakeScenario, reviewName: string): GbpReview {
    for (const entry of Object.values(scenario.reviews)) {
      const hit = entry.reviews.find((r) => r.name === reviewName);
      if (hit) return hit;
    }
    throw new GbpProviderError("not_found", { status: 404 });
  }

  return {
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(redirectUri);
      url.searchParams.set("code", `fake-code:${bound}`);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code) {
      if (!mine(CODE_RE, code)) throw new GbpProviderError("revoked", { status: 400 });
      await consume(await load(), "exchangeCode");
      return mint(true);
    },

    async refresh(refreshToken) {
      if (!mine(REFRESH_RE, refreshToken)) throw new GbpProviderError("revoked", { status: 400 });
      const scenario = await load();
      await consume(scenario, "refresh");
      if (scenario.revoked) throw new GbpProviderError("revoked", { status: 400 });
      return mint(!!scenario.rotateRefreshToken);
    },

    async revoke(token) {
      if (!mine(REFRESH_RE, token) && !mine(ACCESS_RE, token)) {
        throw new GbpProviderError("revoked", { status: 400 });
      }
      await consume(await load(), "revoke");
    },

    async listAccounts(accessToken, pageToken) {
      const scenario = await authed(accessToken, "listAccounts");
      return asPage(scenario.accounts, pageToken);
    },

    async listLocations(accessToken, accountName, pageToken) {
      const scenario = await authed(accessToken, "listLocations");
      if (!scenario.accounts.some((a) => a.name === accountName)) {
        throw new GbpProviderError("not_found", { status: 404 });
      }
      return asPage(scenario.locations[accountName] ?? [], pageToken);
    },

    async listReviews(accessToken, { accountName, locationName }, pageToken) {
      const scenario = await authed(accessToken, "listReviews");
      const failing = scenario.failReviewsPage;
      if (failing && failing.pageToken === (pageToken ?? null)) {
        if (failing.times !== undefined) {
          if (failing.times <= 1) delete scenario.failReviewsPage;
          else failing.times -= 1;
          await store.set(bound, scenario);
        }
        throw new GbpProviderError(failing.kind);
      }
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
      const summary = pageToken && scenario.laterPages ? scenario.laterPages : entry;
      return {
        reviews: slice,
        averageRating: summary.averageRating,
        totalReviewCount: summary.totalReviewCount,
        nextPageToken: next,
      };
    },

    async putReply(accessToken, reviewName, comment) {
      await logCall("putReply", reviewName);
      const scenario = await authed(accessToken, "putReply");
      const target = findReview(scenario, reviewName);
      target.reply = { comment, updateTime: new Date().toISOString() };
      await store.set(bound, scenario);
      return target.reply;
    },

    async deleteReply(accessToken, reviewName) {
      await logCall("deleteReply", reviewName);
      const scenario = await authed(accessToken, "deleteReply");
      findReview(scenario, reviewName).reply = null;
      await store.set(bound, scenario);
    },
  };
}
