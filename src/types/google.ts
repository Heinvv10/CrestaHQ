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
  /**
   * Set when Google refused the stored grant (revoked / expired refresh
   * token) or it lacks the business.manage scope. The secret doc is KEPT so a
   * disconnect can still best-effort revoke. A successful reconnect clears it.
   */
  reconnectRequired?: boolean;
  reconnectReason?: GoogleReconnectReason | null;
}

export type GoogleReconnectReason = "revoked" | "insufficient_scope";

/**
 * The GBP listing this sub-account manages — `SubAccountDoc.googleListing`.
 * Member-readable display data, written ONLY by the server after it re-fetched
 * the location through the provider (never from client-supplied fields).
 *
 * `locationName` (`locations/{l}`) + `accountName` (`accounts/{a}`) are the
 * resource keys. `placeId`/`mapsUri`/`newReviewUri` are display/link data
 * only — a Place ID is not a GBP resource name.
 */
export interface GoogleListing {
  accountName: string;
  accountDisplayName: string;
  locationName: string;
  title: string;
  address: string;
  websiteUri: string | null;
  placeId: string | null;
  mapsUri: string | null;
  newReviewUri: string | null;
  selectedAt: Date;
  selectedByUid: string;
}

/**
 * The public reviews widget — `SubAccountDoc.gbpWidgetMeta`. Member-readable:
 * `publicId` is public by nature (it is in the embed snippet). The
 * authoritative, server-only config is `gbpWidgets/{publicId}`.
 */
export interface GbpWidgetMeta {
  publicId: string;
  enabled: boolean;
  /** Normalised `scheme://host[:port]`; https only, except loopback http for dev. */
  allowedOrigins: string[];
  /** 1–50. There is deliberately NO rating filter. */
  maxReviews: number;
  /** Absent on a widget saved before layouts existed: reads as "carousel". */
  layout?: GbpWidgetLayout;
  /** Absent on a widget saved before themes existed: reads as "light". */
  theme?: GbpWidgetTheme;
  updatedAt: Date;
}

/** How the embed draws the reviews. Served to it as the feed's `display`. */
export type GbpWidgetLayout = "carousel" | "grid" | "list" | "badge";
export type GbpWidgetTheme = "light" | "dark";

/** Path of the locked secret doc. One place so no caller can typo it open. */
export function googleConnectionSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/googleConnection`;
}
