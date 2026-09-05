/**
 * WhatsApp agent-bridge connection — the `bridge` arm of the WhatsApp provider
 * seam (services/wa-agent-bridge is the Go process on the other end).
 *
 * The credential split mirrors the Cloud one exactly, and for the same reason:
 * `subAccounts/{id}` is readable by every active member and Firestore rules are
 * document-level, so a token stored as a field up there is visible to every
 * collaborator seat. A bridge consumer token sends messages from the operator's
 * own WhatsApp number, so it lives in the locked `private/` subcollection and
 * only non-secret display metadata lives on the parent.
 */

export const WHATSAPP_BRIDGE_CONNECTION_DOC_ID = "whatsappBridge";

/** Firestore path to the server-only secret. */
export function whatsappBridgeSecretPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/private/${WHATSAPP_BRIDGE_CONNECTION_DOC_ID}`;
}

/**
 * SERVER ONLY — `subAccounts/{id}/private/whatsappBridge`.
 * Never returned by an API route, never sent to a browser.
 *
 * Two secrets, deliberately distinct and easy to confuse:
 *   `token`         — OUR credential when calling the bridge (Bearer on /v1/*).
 *   `webhookSecret` — the bridge's credential when calling US; it signs inbound
 *                     deliveries with it (LeadStack-Signature). Swapping them
 *                     produces a bridge that sends fine and drops every reply,
 *                     so they are named for their direction rather than "key".
 */
export interface WhatsappBridgeSecret {
  /** Base URL of the bridge process, e.g. "http://100.96.203.105:33001". */
  baseUrl: string;
  token: string;
  webhookSecret: string;
}

/**
 * Non-secret half, stored on the parent sub-account doc as
 * `whatsappBridgeMeta`. Safe to render in settings UI.
 */
export interface WhatsappBridgeMeta {
  /** E.164 display number of the paired WhatsApp account, e.g. "+27784356159". */
  displayPhoneNumber: string | null;
  connectedAt: unknown;
  connectedByUid: string | null;
}
