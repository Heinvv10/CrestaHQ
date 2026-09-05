/**
 * Google Business Profile connection — the OAuth link between a sub-account
 * and the Google account that manages its Business Profile listings.
 *
 * Split in two on purpose, exactly like the Stripe connection (see
 * {@link import("@/types/payments").StripeConnectionMeta}): the refresh token
 * is a long-lived credential and `subAccounts/{id}` is readable by every
 * active member, so the tokens live in the locked `private` subcollection and
 * only display metadata goes on the doc.
 */

/**
 * SERVER ONLY — `subAccounts/{id}/private/googleConnection`.
 * Never returned by an API route, never sent to a browser.
 */
export interface GoogleConnectionSecret {
  /** Long-lived credential. The whole reason this doc is locked. */
  refreshToken: string;
  /** Short-lived (≈1h). Cached so a read doesn't always cost a refresh. */
  accessToken: string;
  /** Epoch ms at which `accessToken` stops working. */
  accessTokenExpiresAt: number;
  /** Scopes Google actually granted, as returned by the token endpoint. */
  scopes: string[];
}

/**
 * Non-secret display metadata — `SubAccountDoc.googleConnectionMeta`.
 * Safe for any active member to read. Never add a token to this object.
 */
export interface GoogleConnectionMeta {
  connected: true;
  /** The Google account that authorised, for the settings card. */
  email: string | null;
  /** Granted scopes — display only; the authoritative copy is the secret doc. */
  scopes: string[];
  connectedAt: Date;
  connectedByUid: string;
}

/** Path of the locked secret doc. One place so no caller can typo it open. */
export function googleConnectionSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/googleConnection`;
}
