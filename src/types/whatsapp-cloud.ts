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
  /** E.164 display number for the connected sender, e.g. "+27784356159". */
  displayPhoneNumber: string | null;
  /** Meta's verified business name on the WABA, when readable. */
  verifiedName: string | null;
  connectedAt: unknown;
  connectedByUid: string | null;
}
