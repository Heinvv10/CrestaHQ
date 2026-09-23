import "server-only";

import { parsePhoneNumberFromString } from "libphonenumber-js";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastAudienceFilter, VoiceCampaignSuppression } from "@/types";
import type { Contact } from "@/types/contacts";

/** Reasons a contact can be dropped before dialling. */
export type VoiceAudienceSkipReason =
  | "opted_out"
  | "no_phone"
  | "recently_called"
  | "suppressed_tag"
  | "prior_campaign";

/**
 * Resolve a voice campaign's audience filter to the contact set we'll dial.
 *
 * Mirrors lib/broadcasts/audience.ts but pre-filters on PHONE viability
 * instead of email: a contact is skipped here only when they have no valid
 * phone number or have opted out of voice. The per-call compliance gate
 * (calling window, caps, country, scrub) runs later in the step callback —
 * those checks are time/state-dependent so they can't be decided at
 * fan-out time.
 *
 * Reuses BroadcastAudienceFilter (all / tag / pipeline_stage).
 */
export interface ResolvedVoiceAudience {
  recipients: Contact[];
  skipped: Array<{
    contact: Contact;
    reason: VoiceAudienceSkipReason;
  }>;
}

/** Contacts read per fanout page — bounded so no request loads a whole list. */
export const VOICE_AUDIENCE_PAGE_SIZE = 200;

/** The filter's contact query, unpaged — callers add a count() or a page. */
export function voiceAudienceQuery(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
): FirebaseFirestore.Query {
  let query: FirebaseFirestore.Query = getAdminDb()
    .collection("contacts")
    .where("subAccountId", "==", subAccountId);

  if (filter.kind === "tag") {
    query = query.where("tags", "array-contains", filter.tag);
  } else if (filter.kind === "pipeline_stage") {
    query = query.where("pipelineStage", "==", filter.stage);
  }
  return query;
}

/**
 * How many contacts the audience covers, before opt-out / phone /
 * suppression skips. Unscoped: one aggregate count(). Territory-scoped: a
 * projected scan applying the same territory rule as the page resolver, so
 * a scoped collaborator never sees (or is capped by) contacts outside their
 * territories. Stops counting once past `stopAbove`.
 */
export async function countVoiceAudience(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
  territoryFilter: string[] | null,
  stopAbove: number,
): Promise<number> {
  const query = voiceAudienceQuery(subAccountId, filter);
  if (!territoryFilter) return (await query.count().get()).data().count;
  if (territoryFilter.length === 0) return 0;
  let count = 0;
  let cursor: string | null = null;
  for (;;) {
    let page = query.select("territoryId").orderBy(FieldPath.documentId());
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.limit(1000).get();
    for (const d of snap.docs) {
      const tId = d.data().territoryId as string | undefined;
      if (tId && territoryFilter.includes(tId)) count += 1;
    }
    if (count > stopAbove || snap.docs.length < 1000) return count;
    cursor = snap.docs[snap.docs.length - 1]!.id;
  }
}

/**
 * One page of the audience, in document-id order after `cursor` (a contact
 * id, or null for the first page). `nextCursor` is null on the last page.
 */
export async function resolveVoiceAudiencePage(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
  /** Territory scoping — same semantics as the broadcast resolver. */
  territoryFilter: string[] | null,
  /** Optional cross-campaign suppression (recently-called / tag / prior
   *  campaign). Null = no suppression beyond opt-out + phone validity. */
  suppression: VoiceCampaignSuppression | null,
  cursor: string | null,
  limit = VOICE_AUDIENCE_PAGE_SIZE,
): Promise<ResolvedVoiceAudience & { nextCursor: string | null }> {
  const db = getAdminDb();
  let query = voiceAudienceQuery(subAccountId, filter).orderBy(FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.limit(limit).get();

  // Build the suppression inputs up front.
  const recentCutoff =
    suppression?.recentDays && suppression.recentDays > 0
      ? Timestamp.fromMillis(
          Date.now() - suppression.recentDays * 24 * 60 * 60 * 1000,
        )
      : null;
  const excludeTag = suppression?.excludeTag?.trim() || null;

  // Prior-campaign exclusion: which of THIS page's contacts were recipients
  // of that campaign (recipient doc id === contact id).
  let priorIds: Set<string> | null = null;
  if (suppression?.excludeCampaignId && snap.docs.length > 0) {
    const priorCol = db
      .collection("voiceCampaigns")
      .doc(suppression.excludeCampaignId)
      .collection("recipients");
    const priorSnaps = await db.getAll(...snap.docs.map((d) => priorCol.doc(d.id)));
    priorIds = new Set(priorSnaps.filter((p) => p.exists).map((p) => p.id));
  }

  const recipients: Contact[] = [];
  const skipped: ResolvedVoiceAudience["skipped"] = [];

  for (const doc of snap.docs) {
    const contact = { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
    if (territoryFilter) {
      const tId = contact.territoryId ?? null;
      if (!tId || !territoryFilter.includes(tId)) continue;
    }
    if (contact.voiceOptedOut === true) {
      skipped.push({ contact, reason: "opted_out" });
      continue;
    }
    const parsed = contact.phone
      ? parsePhoneNumberFromString(contact.phone)
      : null;
    if (!parsed || !parsed.isValid()) {
      skipped.push({ contact, reason: "no_phone" });
      continue;
    }
    // ----- Suppression layers -----
    if (priorIds && priorIds.has(contact.id)) {
      skipped.push({ contact, reason: "prior_campaign" });
      continue;
    }
    if (excludeTag && (contact.tags ?? []).includes(excludeTag)) {
      skipped.push({ contact, reason: "suppressed_tag" });
      continue;
    }
    if (recentCutoff) {
      const last = contact.lastOutboundCallAt as Timestamp | null | undefined;
      if (
        last &&
        typeof (last as Timestamp).toMillis === "function" &&
        (last as Timestamp).toMillis() >= recentCutoff.toMillis()
      ) {
        skipped.push({ contact, reason: "recently_called" });
        continue;
      }
    }
    recipients.push(contact);
  }

  const last = snap.docs[snap.docs.length - 1];
  return {
    recipients,
    skipped,
    nextCursor: snap.docs.length === limit && last ? last.id : null,
  };
}
