import "server-only";

import webpush from "web-push";
import { getAdminDb } from "@/lib/firebase/admin";
import { pushIsConfigured, getVapidKeys } from "@/lib/push/config";
import { CUSTOM_BRAND } from "@/config/landing";
import { GLOBAL_TERRITORY_ID } from "@/types/tenancy";
import type {
  AgencyDoc,
  SubAccountDoc,
  SubAccountMemberDoc,
} from "@/types";

/**
 * Fan a push notification out to everyone who should hear about an event
 * in a sub-account. Fire-and-forget: callers `void` this, every failure is
 * swallowed with a console.warn, and nothing here ever blocks or breaks
 * the originating write (the emit sites include provider webhook routes
 * that must always 200 fast).
 *
 * Recipient resolution (per PWA_V1_PLAN.md):
 *   1. Explicit sub-account members (status active) — default ON, their
 *      prefs doc can turn a sub-account off.
 *   2. The agency owner, if not already an explicit member — OPT-IN only
 *      (prefs key must be exactly true), since implicit-admin-everywhere
 *      would otherwise buzz them for every event in every client account.
 *   3. When territory scoping is on and the event carries a territoryId,
 *      collaborators only receive it for territories they're assigned to
 *      (admins and Global-territory events pass for everyone) — mirroring
 *      the read-side rules so a push can't leak a lead a rep can't open.
 *
 * Membership is re-checked at send time, so a removed member stops
 * receiving pushes the moment their membership row flips — even if their
 * device subscription rows still exist.
 */

export interface SendPushInput {
  subAccountId: string;
  agencyId: string;
  title: string;
  body: string;
  /** App-relative deep link, e.g. /sa/abc/contacts/xyz */
  url: string;
  /** Collapse key — same tag replaces the previous notification. */
  tag?: string;
  /** Territory of the underlying record, when the feature applies. */
  territoryId?: string | null;
}

interface Recipient {
  uid: string;
  role: string;
  assignedTerritoryIds: string[];
  /** true = prefs key must be exactly true to receive (agency owner). */
  optInOnly: boolean;
}

export async function sendPushForEvent(input: SendPushInput): Promise<void> {
  try {
    if (!pushIsConfigured()) return;
    const db = getAdminDb();

    const [saSnap, agencySnap, membersSnap] = await Promise.all([
      db.doc(`subAccounts/${input.subAccountId}`).get(),
      db.doc(`agencies/${input.agencyId}`).get(),
      db.collection(`subAccounts/${input.subAccountId}/subAccountMembers`).get(),
    ]);
    if (!saSnap.exists) return;
    const subAccount = saSnap.data() as SubAccountDoc;
    const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

    const recipients = new Map<string, Recipient>();
    for (const doc of membersSnap.docs) {
      const m = doc.data() as SubAccountMemberDoc;
      if (m.status !== "active") continue;
      recipients.set(doc.id, {
        uid: doc.id,
        role: m.role,
        assignedTerritoryIds: m.assignedTerritoryIds ?? [],
        optInOnly: false,
      });
    }
    if (agency?.ownerUid && !recipients.has(agency.ownerUid)) {
      recipients.set(agency.ownerUid, {
        uid: agency.ownerUid,
        role: "agencyOwner",
        assignedTerritoryIds: [],
        optInOnly: true,
      });
    }
    if (recipients.size === 0) return;

    // Territory gate — collaborators only hear about territories they can
    // read. Admins/owner always pass; Global (or untagged) events pass for
    // everyone, matching the shared-floor read semantics.
    const scopingOn = subAccount.territoryScopingEnabled === true;
    const territoryId = input.territoryId ?? null;
    const territoryApplies =
      scopingOn && !!territoryId && territoryId !== GLOBAL_TERRITORY_ID;

    const eligible = [...recipients.values()].filter((r) => {
      if (!territoryApplies) return true;
      // SubAccountRole is "admin" | "collaborator"; only collaborators are
      // territory-scoped (admins + the synthetic agencyOwner always pass).
      if (r.role !== "collaborator") return true;
      return r.assignedTerritoryIds.includes(territoryId!);
    });
    if (eligible.length === 0) return;

    const { publicKey, privateKey } = getVapidKeys();
    const subject = `mailto:${CUSTOM_BRAND.supportEmail}`;
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url,
      tag: input.tag,
    });

    await Promise.all(
      eligible.map(async (recipient) => {
        try {
          const prefsSnap = await db
            .doc(`users/${recipient.uid}/settings/notifications`)
            .get();
          const prefs =
            (prefsSnap.data()?.subAccounts as
              | Record<string, boolean>
              | undefined) ?? {};
          const pref = prefs[input.subAccountId];
          const enabled = recipient.optInOnly ? pref === true : pref !== false;
          if (!enabled) return;

          const subsSnap = await db
            .collection(`users/${recipient.uid}/pushSubscriptions`)
            .get();
          await Promise.all(
            subsSnap.docs.map(async (subDoc) => {
              const sub = subDoc.data();
              try {
                await webpush.sendNotification(
                  {
                    endpoint: sub.endpoint as string,
                    keys: sub.keys as { p256dh: string; auth: string },
                  },
                  payload,
                  { vapidDetails: { subject, publicKey, privateKey } },
                );
              } catch (err) {
                const status = (err as { statusCode?: number }).statusCode;
                // 404/410 = the browser dropped the subscription (app
                // uninstalled, permission revoked). Prune the dead row.
                if (status === 404 || status === 410) {
                  await subDoc.ref.delete().catch(() => {});
                } else {
                  console.warn(
                    `[push/send] delivery failed for ${recipient.uid}`,
                    err,
                  );
                }
              }
            }),
          );
        } catch (err) {
          console.warn(`[push/send] recipient ${recipient.uid} failed`, err);
        }
      }),
    );
  } catch (err) {
    console.warn("[push/send] sendPushForEvent failed", err);
  }
}
