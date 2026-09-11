import "server-only";

import { buildGoogleOAuthUrl } from "@/lib/google/oauth";
import { bearer, fetchJson } from "./google-http";
import { parseAccounts, parseLocations, parseReply, parseReviews } from "./google-parse";
import { exchangeCode, refresh, revoke } from "./google-token";
import {
  ACCOUNT_NAME_RE,
  LOCATION_NAME_RE,
  REVIEW_NAME_RE,
  type GbpProvider,
} from "./types";

/**
 * The real Google Business Profile provider. Endpoints verified 2026-09-11
 * against developers.google.com:
 *   accounts   Account Management API v1   (pageSize max 20)
 *   locations  Business Information API v1 (readMask REQUIRED, pageSize max 100)
 *   reviews    legacy My Business API v4   (pageSize max 50) — the only API
 *              that serves reviews; access needs Google's approval.
 */

const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4 = "https://mybusiness.googleapis.com/v4";
const LOCATION_READ_MASK = "name,title,storefrontAddress,websiteUri,metadata";
/**
 * Reply calls abort after 30 s (→ `transient`), well inside the reply
 * ledger's 2-minute pending window, so a pending attempt past it is dead.
 */
const REPLY_TIMEOUT_MS = 30_000;

/** Refuse a resource name that could smuggle extra path segments. */
function assertName(value: string, re: RegExp, what: string): void {
  if (!re.test(value)) throw new TypeError(`Invalid GBP ${what} resource name`);
}

function withPage(params: URLSearchParams, pageToken?: string): string {
  if (pageToken) params.set("pageToken", pageToken);
  return params.toString();
}

export const googleGbpProvider: GbpProvider = {
  authorizeUrl: ({ redirectUri, state }) => buildGoogleOAuthUrl({ redirectUri, state }),
  exchangeCode,
  refresh,
  revoke,

  async listAccounts(accessToken, pageToken) {
    const qs = withPage(new URLSearchParams({ pageSize: "20" }), pageToken);
    return parseAccounts(
      await fetchJson(`${ACCOUNTS}/accounts?${qs}`, { headers: bearer(accessToken) }),
    );
  },

  async listLocations(accessToken, accountName, pageToken) {
    assertName(accountName, ACCOUNT_NAME_RE, "account");
    const qs = withPage(
      new URLSearchParams({ readMask: LOCATION_READ_MASK, pageSize: "100" }),
      pageToken,
    );
    return parseLocations(
      await fetchJson(`${BUSINESS_INFO}/${accountName}/locations?${qs}`, {
        headers: bearer(accessToken),
      }),
    );
  },

  async listReviews(accessToken, { accountName, locationName }, pageToken) {
    assertName(accountName, ACCOUNT_NAME_RE, "account");
    assertName(locationName, LOCATION_NAME_RE, "location");
    // Business Information names a location `locations/{l}`; v4 nests it under
    // its account: `accounts/{a}/locations/{l}/reviews`.
    // URLSearchParams writes the space as "+"; emit the documented "%20".
    // Safe: a literal "+" inside a page token is encoded as "%2B".
    const qs = withPage(
      new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc" }),
      pageToken,
    ).replace(/\+/g, "%20");
    return parseReviews(
      await fetchJson(`${V4}/${accountName}/${locationName}/reviews?${qs}`, {
        headers: bearer(accessToken),
      }),
    );
  },

  async putReply(accessToken, reviewName, comment) {
    assertName(reviewName, REVIEW_NAME_RE, "review");
    return parseReply(
      await fetchJson(`${V4}/${reviewName}/reply`, {
        method: "PUT",
        headers: { ...bearer(accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ comment }),
        signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
      }),
    );
  },

  async deleteReply(accessToken, reviewName) {
    assertName(reviewName, REVIEW_NAME_RE, "review");
    await fetchJson(`${V4}/${reviewName}/reply`, {
      method: "DELETE",
      headers: bearer(accessToken),
      signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    });
  },
};
