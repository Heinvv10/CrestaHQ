import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { ActivityType } from "@/types/contacts";
import type { ActivityMeta } from "@/types/activities";

/**
 * Admin-SDK twin of lib/firestore/activities.ts::addActivity() — the webhook
 * receiver and the CRM-side register route run server-side, so the client
 * helper can't be used. Same doc shape, same subcollection.
 */
export async function logWebinarActivity(
  contactId: string,
  payload: {
    type: ActivityType;
    content: string;
    createdBy: string;
    meta?: ActivityMeta;
    /**
     * Deterministic doc id (e.g. `webinar_registered_<registrationId>`).
     * Webinar1 retries failed deliveries, and a CRM-side push is followed by
     * its own `registration.created` webhook — with a stable id both writes
     * collapse into one timeline row. `create()` + swallowed ALREADY_EXISTS
     * keeps the FIRST row's timestamp (a retry must not bump the row to
     * "just now").
     */
    dedupeKey: string;
  }
): Promise<void> {
  const ref = getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .doc(payload.dedupeKey);
  try {
    await ref.create({
      type: payload.type,
      content: payload.content,
      createdBy: payload.createdBy,
      meta: payload.meta ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // ALREADY_EXISTS (gRPC code 6) = duplicate delivery — the row is there.
    if ((err as { code?: number }).code !== 6) throw err;
  }
}
