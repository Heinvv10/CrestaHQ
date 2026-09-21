import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  WA_BRIDGE_RISK_TEXT,
  WA_BRIDGE_RISK_TEXT_ID,
  whatsappBridgeRiskAcksPath,
} from "@/types/whatsapp-bridge";

/**
 * The recorded ban-risk acknowledgement for the bridge rail.
 *
 * Two functions on purpose: the route that records one and the route that
 * refuses without one must agree on the path and on which version counts. Two
 * copies of that query is how the gate ends up matching a field the writer
 * stopped writing, and a gate that always passes looks exactly like a gate.
 */

/**
 * Append one acknowledgement. Never updates, never overwrites.
 *
 * `add` rather than a deterministic id: a second connect is a second decision,
 * on a later date and possibly by a different admin, and collapsing them onto
 * one document would silently discard the earlier one — the one covering the
 * period a ban would be argued about.
 *
 * The timestamp is the SERVER's. A browser clock is attacker-controlled and,
 * more mundanely, often just wrong.
 */
export async function recordRiskAck(
  subAccountId: string,
  uid: string,
): Promise<void> {
  await getAdminDb()
    .collection(whatsappBridgeRiskAcksPath(subAccountId))
    .add({
      uid,
      acknowledgedAt: FieldValue.serverTimestamp(),
      textId: WA_BRIDGE_RISK_TEXT_ID,
      // Copied in rather than referenced. A record that named only the id
      // becomes unreadable the day this constant is edited.
      text: WA_BRIDGE_RISK_TEXT,
    });
}

/**
 * Has anyone in this workspace agreed to the CURRENT warning?
 *
 * Matched on `textId`, not on mere existence: bumping the id after a material
 * change to the wording re-asks everyone, because an admin who saw the old
 * text has not agreed to the new one.
 */
export async function hasCurrentRiskAck(
  subAccountId: string,
): Promise<boolean> {
  const snap = await getAdminDb()
    .collection(whatsappBridgeRiskAcksPath(subAccountId))
    .where("textId", "==", WA_BRIDGE_RISK_TEXT_ID)
    .limit(1)
    .get();
  return !snap.empty;
}
