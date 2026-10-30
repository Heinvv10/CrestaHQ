/**
 * Meta WhatsApp Cloud API connection — the `cloud` arm of the WhatsApp
 * provider seam (see docs/WHATSAPP_PROVIDER_PLAN.md).
 *
 * The credential split mirrors Payments v1 exactly, and for the same reason:
 * `subAccounts/{id}` is readable by every active member, and Firestore rules
 * are document-level, so a token stored as a field up there is visible to
 * every collaborator seat. A WABA system-user token is worth more than most —
 * it sends messages billed to us and manages templates — so it lives in the
 * locked `private/` subcollection and non-secret display metadata lives on the
 * parent.
 */

export const WHATSAPP_CLOUD_CONNECTION_DOC_ID = "whatsappCloudConnection";

/** Firestore path to the server-only secret. */
export function whatsappCloudSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${WHATSAPP_CLOUD_CONNECTION_DOC_ID}`;
}

/**
 * SERVER ONLY — `subAccounts/{id}/private/whatsappCloudConnection`.
 * Never returned by an API route, never sent to a browser.
 *
 * Two ids, deliberately distinct and easy to confuse:
 *   `phoneNumberId` — the sending number resource; used on /{id}/messages.
 *   `wabaId`        — the business account owning it; used on
 *                     /{id}/message_templates.
 * A send authorised with the WABA id fails with a confusing 404, so they are
 * validated separately at connect time.
 */
export interface WhatsappCloudSecret {
  phoneNumberId: string;
  wabaId: string;
  /** System-user or long-lived access token with whatsapp_business_messaging. */
  accessToken: string;
}

/**
 * Non-secret half, stored on the parent sub-account doc as
 * `whatsappCloudMeta`. Safe to render in settings UI.
 */
export interface WhatsappCloudMeta {
  /**
   * The sending number's Meta resource id — DUPLICATED from the secret doc on
   * purpose. Inbound webhooks identify the recipient by this id, so routing
   * needs to query it, and querying it here beats a collection-group query
   * across every sub-account's `private/` subcollection — which would build an
   * index over documents that exist precisely to be unreadable. The id is an
   * identifier, not a credential; only the access token is secret. Written
   * atomically with the secret doc by the connection route.
   */
  phoneNumberId: string | null;
  /** E.164 display number for the connected sender, e.g. "+27784356159". */
  displayPhoneNumber: string | null;
  /** Meta's verified business name on the WABA, when readable. */
  verifiedName: string | null;
  connectedAt: unknown;
  connectedByUid: string | null;
  /**
   * Last quality-rating reading from the hourly poll (SP15). Absent until the
   * first sweep after connection; `null` never written, tolerated on read.
   */
  quality?: StoredQuality | null;
}

/** Meta's `quality_rating`; anything unrecognised (incl. "NA") is UNKNOWN. */
export type WaQualityRating = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";

/**
 * `whatsappCloudMeta.quality` — what the poll last saw on the phone-number
 * node. `changedAt` moves only when `rating` changes, so the settings page can
 * say "Yellow since Tuesday" rather than "checked an hour ago".
 */
export interface StoredQuality {
  rating: WaQualityRating;
  nameStatus: string | null;
  status: string | null;
  checkedAt: unknown;
  changedAt: unknown;
}

/**
 * `subAccounts/{id}/whatsappQualityAlerts/{autoId}` — one doc per drop from
 * GREEN, written by the quality sweep (`createdByUid: "system"`); `resolvedAt`
 * is set when the rating is next seen GREEN. Member-readable, server-written.
 */
export interface WhatsappQualityAlertDoc {
  agencyId: string;
  subAccountId: string;
  createdByUid: "system";
  from: WaQualityRating;
  to: WaQualityRating;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  createdAt: unknown;
  resolvedAt: unknown | null;
}
