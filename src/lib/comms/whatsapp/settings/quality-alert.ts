import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail } from "@/lib/comms/resend";
import { sendPushForEvent } from "@/lib/push/send";
import type { SubAccountDoc } from "@/types";
import type { WaQualityRating, WhatsappQualityAlertDoc } from "@/types/whatsapp-cloud";

/**
 * What a quality DROP does beyond storing the reading: an alert doc, a push
 * to the sub-account, and an email to the agency owner — the same owner
 * resolution as usage-meter.ts's `notifyOwner` (ownerUid → users/{uid}.email,
 * else the agency's supportEmail). Each channel fails on its own and is
 * logged; none of them can fail the sweep.
 */

const LABEL: Record<WaQualityRating, string> = {
  GREEN: "Green",
  YELLOW: "Yellow",
  RED: "Red",
  UNKNOWN: "Unknown",
};

export function alertsCollection(subAccountId: string): string {
  return `subAccounts/${subAccountId}/whatsappQualityAlerts`;
}

export interface DropInput {
  subAccountId: string;
  sub: SubAccountDoc;
  from: WaQualityRating;
  to: WaQualityRating;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  now: Date;
}

export async function recordQualityDrop(input: DropInput): Promise<void> {
  const { subAccountId, sub, from, to, phoneNumberId, displayPhoneNumber, now } = input;
  const doc: WhatsappQualityAlertDoc = {
    agencyId: sub.agencyId,
    subAccountId,
    createdByUid: "system",
    from,
    to,
    phoneNumberId,
    displayPhoneNumber,
    createdAt: now,
    resolvedAt: null,
  };
  await getAdminDb().collection(alertsCollection(subAccountId)).doc().set(doc);

  const number = displayPhoneNumber ?? phoneNumberId;
  const settingsUrl = `/sa/${subAccountId}/dashboard/settings/whatsapp`;
  void sendPushForEvent({
    subAccountId,
    agencyId: sub.agencyId,
    title: `WhatsApp quality dropped to ${LABEL[to]}`,
    body: `${number} — check the WhatsApp settings page`,
    url: settingsUrl,
    tag: `wa-quality-${phoneNumberId}`,
  });
  await emailOwner(subAccountId, sub, { from, to, number, settingsUrl });
}

async function emailOwner(
  subAccountId: string,
  sub: SubAccountDoc,
  d: { from: WaQualityRating; to: WaQualityRating; number: string; settingsUrl: string },
): Promise<void> {
  try {
    if (!emailIsConfigured(sub)) return;
    const db = getAdminDb();
    const agencySnap = await db.doc(`agencies/${sub.agencyId}`).get();
    const ownerUid = agencySnap.data()?.ownerUid as string | undefined;
    let to: string | null = null;
    if (ownerUid) {
      const ownerSnap = await db.doc(`users/${ownerUid}`).get();
      to = (ownerSnap.data()?.email as string | undefined) ?? null;
    }
    to = to ?? (agencySnap.data()?.supportEmail as string | undefined) ?? null;
    if (!to) return;

    const wsName = sub.name || subAccountId;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
    await sendEmail({
      to,
      subject: `${wsName}: WhatsApp quality rating dropped to ${LABEL[d.to]}`,
      text: [
        `Meta now rates the WhatsApp number ${d.number} on ${wsName} as ${LABEL[d.to]} (it was ${LABEL[d.from]}).`,
        "",
        "A Yellow or Red rating throttles how many customers the number can message and can lead to it being restricted. It usually follows a run of blocks or reports, so review recent broadcasts and templates.",
        "",
        `Details: ${appUrl}${d.settingsUrl}`,
      ].join("\n"),
      subAccount: sub,
      meter: { subAccountId },
      // Internal staff notification — not a customer conversation.
      archive: false,
    });
  } catch (err) {
    console.warn("[whatsapp-quality] owner alert failed", {
      subAccountId,
      err: err instanceof Error ? err.name : typeof err,
    });
  }
}

/** Close every open alert for the sub-account (the rating is GREEN again). */
export async function resolveOpenAlerts(subAccountId: string, now: Date): Promise<number> {
  const open = await getAdminDb()
    .collection(alertsCollection(subAccountId))
    .where("resolvedAt", "==", null)
    .get();
  await Promise.all(open.docs.map((d) => d.ref.set({ resolvedAt: now }, { merge: true })));
  return open.size;
}
