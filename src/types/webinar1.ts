/**
 * Webinar1 integration — connect a sub-account to a self-hosted Webinar1
 * deployment (webinar1.dev boilerplate, same product family as LeadStack).
 *
 * What it does once connected:
 *  - Create evergreen webinars + list videos from inside the CRM (proxied
 *    through `/api/sub-accounts/{id}/webinar1/*`).
 *  - Push a contact into a webinar (registration → Webinar1 sends the whole
 *    email sequence).
 *  - Receive signed webhooks (`registration.created`, `attendee.joined`,
 *    `attendee.completed`, `cta.clicked`) at
 *    `/api/webhooks/webinar1/sa/{subAccountId}` and turn them into
 *    contacts + timeline activities.
 *
 * SECRET SPLIT — same rule as payments.ts: the API key + webhook signing
 * secret live in the locked `private/` subcollection (`allow read, write:
 * if false`, Admin SDK only). Only non-secret display metadata goes on the
 * sub-account doc, which any active member can read.
 */

/** Doc id of the locked secret doc under `subAccounts/{id}/private`. */
export const WEBINAR1_CONNECTION_DOC_ID = "webinar1Connection";

/** Firestore path to the server-only secret. */
export function webinar1ConnectionSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${WEBINAR1_CONNECTION_DOC_ID}`;
}

/**
 * SERVER ONLY — `subAccounts/{id}/private/webinar1Connection`.
 * Never returned by an API route, never sent to a browser.
 */
export interface Webinar1ConnectionSecret {
  /** Deployment origin, e.g. `https://webinars.acme.com` (no trailing slash). */
  baseUrl: string;
  /** Workspace API key (`wbk_…`) minted in Webinar1 → Settings → API. */
  apiKey: string;
  /**
   * Signing secret (`whsec_…`) for the webhook endpoint we registered on the
   * Webinar1 side. Empty string while awaiting a manual paste (the fallback
   * when auto-registration failed, e.g. no public app URL in dev).
   */
  webhookSecret: string;
  /** Id of the remote endpoint we registered, for cleanup on disconnect. */
  webhookEndpointId: string | null;
}

/**
 * Non-secret display metadata — `SubAccountDoc.webinar1ConnectionMeta`.
 * Safe for any active member to read.
 */
export interface Webinar1ConnectionMeta {
  baseUrl: string;
  /** First characters of the key (`wbk_AbCdEfGh`) so the admin can tell which key is stored. */
  keyPrefix: string;
  /** False while the inbound webhook still needs its manual signing-secret paste. */
  webhookReady: boolean;
  connectedAt: Date;
}

/** Wire shapes returned by Webinar1's /api/launchcast/v1 endpoints. */
export interface Webinar1Video {
  id: string;
  title: string;
  status: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  createdAt: string | null;
}

export interface Webinar1Webinar {
  id: string;
  title: string;
  slug: string;
  /** Public registration page on the Webinar1 deployment. */
  url: string;
  isActive: boolean;
  scheduleMode: string;
  videoId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Events our receiver subscribes to (everything else is noise for a CRM). */
export const WEBINAR1_SUBSCRIBED_EVENTS = [
  "registration.created",
  "attendee.joined",
  "attendee.completed",
  "cta.clicked",
] as const;
