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

/**
 * The bridge rail is an UNOFFICIAL WhatsApp connection — a whatsmeow linked
 * device, the same mechanism WhatsApp Web uses, driven by software WhatsApp
 * does not sanction. The number can be banned. A sub-account admin therefore
 * cannot provision one without a RECORDED acknowledgement, and the record has
 * to answer three questions years later: who agreed, when, and to what.
 *
 * "To what" is why the text lives here as a versioned constant rather than in
 * the component that renders it. A record that stored only a boolean, or only
 * the id, becomes unreadable the moment the wording changes: nobody can say
 * what the person actually saw. The id AND the full text are written into
 * every record, so a stored ack is self-describing even if this file is later
 * deleted.
 *
 * CHANGING THE COPY MEANS A NEW ID. `hasCurrentRiskAck` matches on the id, so
 * bumping it re-asks everyone — which is the point: a materially different
 * warning has not been agreed to by someone who saw the old one. Never edit
 * the text of an existing id in place.
 */
export const WA_BRIDGE_RISK_TEXT_ID = "wa-bridge-risk-v1";

/** The exact words the admin must be shown. Rendered paragraph-per-line. */
export const WA_BRIDGE_RISK_TEXT = [
  "Connecting your own WhatsApp number here links this CRM to it as an extra device, in the same way WhatsApp Web does — but through software WhatsApp does not officially support.",
  "WhatsApp can ban a number connected this way, without warning and with no appeal. A ban can also stop the number being used normally on the phone it belongs to, for personal chats as well as business ones.",
  "You are responsible for the number you connect and for everything sent from it. Do not connect a number you cannot afford to lose.",
].join("\n\n");

/**
 * Firestore path to one sub-account's append-only acknowledgement log.
 *
 * A SUBCOLLECTION rather than a field, because these records must survive
 * disconnect. Disconnect erases the WhatsApp session and the credentials; an
 * audit record that was erased with them would prove nothing about the period
 * the number was actually connected, which is the only period anyone would
 * ever ask about.
 */
export function whatsappBridgeRiskAcksPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/whatsappBridgeRiskAcks`;
}

/** One recorded acknowledgement. Written by the server, never by a client. */
export interface WhatsappBridgeRiskAck {
  /** Who agreed. */
  uid: string;
  /** When, from the server's clock — never the browser's. */
  acknowledgedAt: unknown;
  /** Which version of the warning. */
  textId: string;
  /** The exact words shown, copied in so the record outlives the constant. */
  text: string;
}
