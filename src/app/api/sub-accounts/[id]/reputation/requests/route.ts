import "server-only";

import { NextResponse } from "next/server";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { toMillis } from "@/lib/gbp/sync/types";
import { listingFor, type ListingFields } from "@/lib/gbp/listings";
import { requestKeys } from "@/lib/reputation/overview";
import { REVIEW_REQUEST_CHANNELS, REVIEW_REQUEST_SOURCES, REVIEW_REQUEST_STATUSES } from "@/lib/reviews/request-log";

/**
 * GET /api/sub-accounts/[id]/reputation/requests?status=&channel=&source=&cursor=
 * — the Requests tab (SP5 d1): the server-only reviewRequests log, newest
 * first, 50 matching rows per page. Any active member. One single-field query
 * (`orderBy sentAt desc`, cursor = the last row's id) scanned in batches, with
 * the filters applied as it scans, so no composite index. Contact names are
 * joined at read time from THIS sub-account's contacts, and for a
 * territory-scoped collaborator only from contacts in their territories (an
 * out-of-scope contact's row stays, without its id or name). Never a message
 * body, phone number or email address. A request made for an EXTRA listing
 * (MULTI_LISTING_V1_PLAN.md PR 5) carries that listing's title, or "Removed
 * listing" once it is no longer connected; every other row `listingTitle: null`.
 */

const PAGE = 50;
const BATCH = 100;
/** Rows examined per request; a sparse filter returns a partial page and a cursor to continue. */
const SCAN_CAP = 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const dynamic = "force-dynamic";

const iso = (v: unknown) => {
  const ms = toMillis(v);
  return ms === null ? null : new Date(ms).toISOString();
};

/** The reminder as the Requests tab shows it (SP5 d2); null when the request had none. */
function reminderOf(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  return {
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    maxRetries: typeof r.maxRetries === "number" ? r.maxRetries : 0,
    state: typeof r.state === "string" ? r.state : "stopped",
    stopReason: typeof r.stopReason === "string" ? r.stopReason : null,
    nextAt: iso(r.nextAt),
    lastAttemptAt: iso(r.lastAttemptAt),
  };
}

const invalid = (field: string) =>
  NextResponse.json({ error: `Invalid filter: ${field}`, code: "invalid_filter", field }, { status: 400 });

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const params = new URL(request.url).searchParams;
  const filters: Record<"status" | "channel" | "source", string | null> = {
    status: params.get("status") || null,
    channel: params.get("channel") || null,
    source: params.get("source") || null,
  };
  // "clicked" (SP5 d2): a sent request whose tracked link was clicked.
  const allowed = { status: [...REVIEW_REQUEST_STATUSES, "clicked"], channel: REVIEW_REQUEST_CHANNELS, source: REVIEW_REQUEST_SOURCES };
  for (const f of ["status", "channel", "source"] as const) {
    const v = filters[f];
    if (v !== null && !(allowed[f] as readonly string[]).includes(v)) return invalid(f);
  }

  const db = getAdminDb();
  const log = db.collection(`subAccounts/${id}/reviewRequests`);
  const cursorId = params.get("cursor");
  let cursor: DocumentSnapshot | null = null;
  if (cursorId !== null) {
    if (!ID.test(cursorId)) return invalid("cursor");
    const snap = await log.doc(cursorId).get();
    if (!snap.exists) return invalid("cursor");
    cursor = snap as DocumentSnapshot;
  }

  // One extra match tells whether another page exists.
  const matches: DocumentSnapshot[] = [];
  let scanned = 0;
  let lastScanned: DocumentSnapshot | null = cursor;
  let exhausted = false;
  while (matches.length <= PAGE && scanned < SCAN_CAP) {
    let q = log.orderBy("sentAt", "desc");
    if (lastScanned) q = q.startAfter(lastScanned);
    const batch = await q.limit(BATCH).get();
    for (const d of batch.docs) {
      scanned++;
      lastScanned = d as DocumentSnapshot;
      const data = d.data();
      const keys = requestKeys(data);
      const status = data.status === "failed" ? "failed" : "sent";
      if (
        (!filters.status || (filters.status === "clicked" ? status === "sent" && data.tracked === true && !!data.clickedAt : status === filters.status)) &&
        (!filters.channel || keys.channel === filters.channel) &&
        (!filters.source || keys.source === filters.source)
      ) {
        matches.push(d as DocumentSnapshot);
        if (matches.length > PAGE) break;
      }
    }
    if (batch.docs.length < BATCH) {
      exhausted = matches.length <= PAGE;
      break;
    }
  }

  const page = matches.slice(0, PAGE);
  const nextCursor =
    matches.length > PAGE ? page[PAGE - 1].id : !exhausted && lastScanned ? lastScanned.id : null;

  const contactIds = [...new Set(page.map((d) => d.data()?.contactId).filter((c): c is string => typeof c === "string" && ID.test(c)))];
  const scope = await loadEffectiveTerritoryScope(access);
  const names = new Map<string, string | null>();
  const hidden = new Set<string>();
  await Promise.all(
    contactIds.map(async (cid) => {
      const c = (await db.doc(`contacts/${cid}`).get()).data();
      // Same rule as territoryDenialForContact: a scoped collaborator sees only
      // contacts whose territory is one of theirs (Global included in the ids);
      // an unassigned or missing contact is hidden too.
      const territoryId = typeof c?.territoryId === "string" ? c.territoryId : null;
      if (scope.enforce && (!territoryId || !(scope.ids ?? []).includes(territoryId))) {
        hidden.add(cid);
        return;
      }
      // Only this sub-account's contacts: a stale id never reveals another tenant's name.
      names.set(cid, c && c.subAccountId === id && typeof c.name === "string" ? c.name : null);
    }),
  );

  const byListing = page.some((d) => typeof d.data()?.locationName === "string");
  const sub = byListing ? (((await db.doc(`subAccounts/${id}`).get()).data() ?? {}) as ListingFields) : {};
  const listingTitle = (loc: unknown) =>
    typeof loc === "string" ? (listingFor(sub, loc)?.title ?? "Removed listing") : null;

  return NextResponse.json({
    requests: page.map((d) => {
      const data = d.data() ?? {};
      const { channel, source } = requestKeys(data);
      const sentAt = toMillis(data.sentAt);
      return {
        id: d.id,
        contactId: typeof data.contactId === "string" && !hidden.has(data.contactId) ? data.contactId : null,
        contactName: names.get(data.contactId) ?? null,
        channel,
        source,
        trigger: typeof data.trigger === "string" ? data.trigger : null,
        status: data.status === "failed" ? "failed" : "sent",
        failureKind: typeof data.failureKind === "string" ? data.failureKind : null,
        sentAt: sentAt === null ? null : new Date(sentAt).toISOString(),
        clickedAt: iso(data.clickedAt),
        tracked: data.tracked === true,
        reminder: reminderOf(data.reminder),
        listingTitle: listingTitle(data.locationName),
      };
    }),
    nextCursor,
  });
}
