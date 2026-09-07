import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  whatsappBridgeConnectionsPath,
  whatsappBridgeSecretPath,
  type WhatsappBridgeConnectionRecord,
  type WhatsappBridgeMeta,
  type WhatsappBridgeSecret,
} from "@/types/whatsapp-bridge";
import type { WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";
import type { SubAccountDoc } from "@/types";

/**
 * The two writes that put a sub-account on the bridge rail, and take it off
 * again.
 *
 * Extracted from the manual connect/disconnect route so the self-serve
 * provisioning routes drive the SAME writes rather than a second copy. Two
 * copies is how one of them stops clearing `whatsappBridgeMeta`, leaving a
 * workspace showing a number it no longer has — and how the credential path
 * drifts, which is worse: a secret written to a path Firestore rules do not
 * cover is readable by every collaborator seat.
 */

/**
 * Store the credentials and switch the workspace onto the bridge.
 *
 * One batch, so the workspace is never switched onto a rail whose credentials
 * are not there yet, and never left holding credentials it is not routed to.
 *
 * `token` and `webhookSecret` go to `subAccounts/{id}/private/whatsappBridge`
 * and NEVER onto the sub-account doc: `subAccounts/{id}` is readable by any
 * active member and Firestore rules are document-level, so a field there is a
 * secret handed to every collaborator seat. Only the display number goes up.
 */
/**
 * Does this workspace already hold bridge credentials?
 *
 * Lives here because this module owns the credential path; a second copy of
 * `whatsappBridgeSecretPath` in a route is how the path drifts. Only the
 * document's EXISTENCE is answered — nothing reads the token back, and no
 * route in this deployment can.
 *
 * The provision route uses it to classify a manager 409 from the CRM's own
 * state instead of from the manager's prose. See the comment there.
 */
export async function hasStoredBridgeCredentials(
  subAccountId: string,
): Promise<boolean> {
  const db = getAdminDb();
  const snap = await db.doc(whatsappBridgeSecretPath(subAccountId)).get();
  return snap.exists;
}

export async function storeBridgeConnection(
  subAccountId: string,
  creds: WhatsappBridgeSecret,
  meta: WhatsappBridgeMeta,
  /**
   * The acknowledged warning version, passed ONLY by a caller that gated on a
   * recorded acknowledgement. Omitted, the record simply carries no such
   * claim. It is a parameter rather than a constant read here because this
   * function is shared with the manual connect route, which has no ack gate —
   * writing the current constant unconditionally would put "they agreed to
   * v1" into an audit record for an admin who was never shown v1.
   */
  ack?: { riskTextId: string },
): Promise<void> {
  // Loudly, not as an empty string. This record exists to answer "who linked
  // this number" in a ban dispute; one naming nobody answers nothing, and a
  // silent "" is a record that looks written and is not. Both callers take the
  // uid from the session, so this can only fire on a wiring mistake.
  if (!meta.connectedByUid) {
    throw new Error(
      "storeBridgeConnection: meta.connectedByUid is required — the connection record must name who connected the number.",
    );
  }
  const db = getAdminDb();
  const batch = db.batch();
  batch.set(db.doc(whatsappBridgeSecretPath(subAccountId)), creds);
  batch.set(
    db.doc(`subAccounts/${subAccountId}`),
    {
      whatsappBridgeMeta: meta,
      whatsappProvider: "bridge",
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  // The audit record of WHO connected this number, in the same batch as the
  // rail switch rather than as a follow-up write: a second write has a failure
  // mode in which the workspace is connected and nobody is named, which is the
  // exact gap this record exists to close. An auto-id, never a deterministic
  // one — a reconnect is a second decision, on a later date and possibly by a
  // different admin, and collapsing them would discard the earlier one.
  //
  // It goes to a subcollection `clearBridgeConnection` does not touch. The
  // only other field naming the connector is `whatsappBridgeMeta.connectedByUid`,
  // and disconnect nulls that — the moment a ban dispute would start.
  const record: WhatsappBridgeConnectionRecord = {
    uid: meta.connectedByUid,
    connectedAt: FieldValue.serverTimestamp(),
    ...(ack ? { riskTextId: ack.riskTextId } : {}),
  };
  batch.set(
    db.collection(whatsappBridgeConnectionsPath(subAccountId)).doc(),
    record,
  );
  await batch.commit();
}

/**
 * Take the workspace off the bridge and delete its credentials. Returns the
 * rail it was moved to.
 *
 * Which rail to fall back to is a QUESTION, not the constant "twilio". A
 * workspace that ran on Cloud, tried the bridge, and disconnected was being
 * moved to Twilio with its Cloud credentials still sitting there — silently
 * swapping a working rail for one it may never have configured. Cloud is
 * restored when its connection is still present; otherwise Twilio, the
 * documented default for a workspace carrying no provider.
 *
 * Repointed BEFORE the credentials are deleted, so there is no interval in
 * which the workspace is aimed at a rail whose token is already gone.
 */
export async function clearBridgeConnection(
  subAccountId: string,
): Promise<WhatsAppProviderId> {
  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const cloudStillConnected =
    (saSnap.data() as SubAccountDoc | undefined)?.whatsappCloudMeta
      ?.phoneNumberId != null;
  const fallback: WhatsAppProviderId = cloudStillConnected ? "cloud" : "twilio";

  await db.doc(`subAccounts/${subAccountId}`).set(
    {
      whatsappProvider: fallback,
      whatsappBridgeMeta: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await db.doc(whatsappBridgeSecretPath(subAccountId)).delete();

  return fallback;
}
