import "server-only";

import { FieldPath } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { BroadcastAudienceFilter } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Resolve a broadcast's audience filter to the contact set we'll fan out to.
 *
 * The query is scoped by sub-account first (drives the index), then narrowed
 * by the optional filter. The pre-flight skip (opted-out / missing email) is
 * applied here so we can show "audience N, will-skip M" in the confirm
 * dialog without a second round-trip — and so the parent broadcast doc's
 * totals.audienceSize matches what we actually queue, never wider.
 *
 * v1 supports three filter shapes:
 *   - { kind: "all" }                            — every contact in the sub-account
 *   - { kind: "tag", tag }                       — contacts whose tags array contains tag
 *   - { kind: "pipeline_stage", stage }          — contacts whose pipelineStage matches
 *
 * v2 will replace this with a saved Smart List doc reference and stack
 * filters (tag AND stage AND source AND ...).
 */
export interface ResolvedAudience {
  /** Contacts that will receive a send (passed all pre-flight checks). */
  recipients: Contact[];
  /** Contacts excluded by pre-flight (opt-out / missing email). */
  skipped: Array<{
    contact: Contact;
    reason: "opt_out" | "no_email";
  }>;
}

/** Contacts read per fanout page — bounded so no request loads a whole list. */
export const AUDIENCE_PAGE_SIZE = 200;

/** The filter's contact query, unpaged — callers add a count() or a page. */
export function audienceQuery(
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
 * How many contacts the audience covers, before opt-out / missing-email
 * skips. Unscoped: one aggregate count(). Territory-scoped: a projected scan
 * applying the same territory rule as the page resolver, so a scoped
 * collaborator never sees (or is capped by) contacts outside their
 * territories. Stops counting once past `stopAbove`.
 */
export async function countAudience(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
  territoryFilter: string[] | null,
  stopAbove: number,
): Promise<number> {
  const query = audienceQuery(subAccountId, filter);
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
export async function resolveAudiencePage(
  subAccountId: string,
  filter: BroadcastAudienceFilter,
  /**
   * Territory scoping. `null` (default) = no restriction (admin / owner
   * / scoping off). A `string[]` restricts the audience to contacts
   * whose `territoryId` is in the list — used when a scoped
   * collaborator initiates the broadcast so they can't blast contacts
   * outside their territory. An empty array yields an empty audience.
   * Territory-excluded contacts are dropped silently (not surfaced in
   * `skipped`) so the collaborator never learns they exist.
   */
  territoryFilter: string[] | null,
  cursor: string | null,
  limit = AUDIENCE_PAGE_SIZE,
): Promise<ResolvedAudience & { nextCursor: string | null }> {
  let query = audienceQuery(subAccountId, filter).orderBy(FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.limit(limit).get();

  const recipients: Contact[] = [];
  const skipped: ResolvedAudience["skipped"] = [];

  for (const doc of snap.docs) {
    const contact = { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
    // Territory gate first — excluded contacts are invisible to this
    // caller, so they don't even count as "skipped".
    if (territoryFilter) {
      const tId = contact.territoryId ?? null;
      if (!tId || !territoryFilter.includes(tId)) continue;
    }
    if (contact.emailOptedOut) {
      skipped.push({ contact, reason: "opt_out" });
      continue;
    }
    if (!contact.email || !contact.email.includes("@")) {
      skipped.push({ contact, reason: "no_email" });
      continue;
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
