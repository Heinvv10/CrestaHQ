import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { getAdminDb } from "@/lib/firebase/admin";
import { locationNamesOf, type ListingFields } from "@/lib/gbp/listings";
import { maybeSendReviewRequest } from "@/lib/reviews/request";

type Body = { contactId?: string; locationName?: unknown };

/**
 * Manual "Request review" send from the contact profile. Auth-gated; delegates
 * to the shared dispatcher with `trigger: "manual"` (which bypasses the
 * cooldown but still stamps it). Returns the dispatcher's outcome so the UI can
 * toast a precise message (sent / not configured / opted out / …).
 *
 * Optional `locationName` (MULTI_LISTING_V1_PLAN.md PR 5): which of the
 * contact's sub-account's listings the request is for — 400 `invalid_listing`
 * unless it is one of them. Absent = the main listing, as before.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  if (!contactId) {
    return NextResponse.json({ error: "contactId is required" }, { status: 400 });
  }

  const locationName = payload.locationName ?? null;
  if (locationName !== null && typeof locationName !== "string") {
    return NextResponse.json({ error: "locationName must be a string", code: "invalid_listing" }, { status: 400 });
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  if (locationName !== null) {
    const sub = (await getAdminDb().doc(`subAccounts/${contact.subAccountId}`).get()).data() as ListingFields | undefined;
    if (!sub || !locationNamesOf(sub).includes(locationName)) {
      return NextResponse.json({ error: "That listing is not one of this sub-account's.", code: "invalid_listing" }, { status: 400 });
    }
  }

  const result = await maybeSendReviewRequest({
    subAccountId: contact.subAccountId,
    agencyId: contact.agencyId,
    contactId,
    trigger: "manual",
    actorUid: auth.uid,
    ...(locationName !== null ? { locationName } : {}),
  });

  return NextResponse.json({ ok: true, sent: result.sent, reason: result.reason });
}
