import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { findAccessibleLocation } from "@/lib/gbp/discovery";
import { clearListing } from "@/lib/gbp/listing-events";
import { withGbpAccess } from "@/lib/gbp/access";
import { clearGbpCache } from "@/lib/gbp/sync/clear";
import { extraLocationNames } from "@/lib/gbp/sync/scope";
import { ACCOUNT_NAME_RE, LOCATION_NAME_RE } from "@/lib/gbp/provider/types";
import { gbpErrorResponse, gbpPreconditions, gbpRefusal } from "@/lib/gbp/route-support";
import { sendAutoReplyAlert } from "@/lib/reputation/auto-reply/alerts";
import type { GoogleListing } from "@/types/google";

/**
 * Choose (PUT) or clear (DELETE) the Business Profile listing this
 * sub-account manages.
 *
 *   PUT    /api/sub-accounts/[id]/google/listing   { accountName, locationName }
 *   DELETE /api/sub-accounts/[id]/google/listing
 *
 * Sub-account admin only. PUT is agency-gated; DELETE is not (like
 * disconnect, clearing must always be possible) — but DELETE refuses 409
 * has_extra_listings while extra listings are connected.
 *
 * PUT trusts only the two resource names: the server re-fetches the pair
 * through the provider and refuses unless THIS connection can see it —
 * 400 unknown_location when the full walk proves it is not there, 400
 * unverifiable_truncated when the 20-page walk stopped before finding it
 * (unproven either way, so still refused); 409 already_extra when the pair
 * is currently one of this sub-account's extra listings. Every display field written comes from that
 * re-fetch, never from the request. Each selection or clear appends an audit
 * event to `subAccounts/{id}/gbpEvents`, in the same transaction as the write.
 */

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const pre = await gbpPreconditions(id);
  if (pre instanceof NextResponse) return pre;

  const body = (await request.json().catch(() => null)) as {
    accountName?: unknown;
    locationName?: unknown;
  } | null;
  const accountName = body?.accountName;
  const locationName = body?.locationName;
  if (
    typeof accountName !== "string" ||
    typeof locationName !== "string" ||
    !ACCOUNT_NAME_RE.test(accountName) ||
    !LOCATION_NAME_RE.test(locationName)
  ) {
    return gbpRefusal(400, "invalid_body", "accountName and locationName are required.");
  }

  let match: Awaited<ReturnType<typeof findAccessibleLocation>>;
  try {
    match = await withGbpAccess(id, (provider, accessToken) =>
      findAccessibleLocation(provider, accessToken, accountName, locationName),
    );
  } catch (err) {
    return gbpErrorResponse(err, id, "gbp/listing");
  }
  // "unknown": the walk hit the page bound before finding the pair, so access
  // is unproven — refuse, but say so honestly rather than "not available".
  if (match === "unknown") {
    return gbpRefusal(
      400,
      "unverifiable_truncated",
      "This Google account has too many listings to verify that one.",
    );
  }
  if (!match) {
    return gbpRefusal(400, "unknown_location", "That listing isn't available to this Google connection.");
  }

  const { account, location } = match;
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${id}`);
  let switchedOff = false;
  const changed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(subRef);
    // One listing, one role: an extra becomes the main only once removed as
    // an extra (its sync would otherwise run in both roles at once).
    if (extraLocationNames(snap.data() ?? {}).includes(location.name)) return "already_extra" as const;
    const previous: string | null = snap.data()?.googleListing?.locationName ?? null;
    // The same location through ANOTHER Google account is a different listing
    // too: Google names its reviews under that account (new cache doc ids).
    const changed = previous !== location.name || snap.data()?.googleListing?.accountName !== account.name;
    // A different listing switches review auto-reply off (modes kept): it was
    // enabled for the old one, and resuming needs an explicit re-enable. When
    // it was ON, the card says why it is off now (`disabledReason`).
    const autoReply = snap.data()?.reviewsAutoReply;
    switchedOff = changed && autoReply?.enabled === true;
    const autoReplyOff = changed && autoReply
      ? { "reviewsAutoReply.enabled": false, ...(autoReply.enabled === true ? { "reviewsAutoReply.disabledReason": "listing_changed" } : {}) }
      : {};
    tx.update(subRef, {
      ...autoReplyOff,
      googleListing: {
        accountName: account.name,
        accountDisplayName: account.accountName,
        locationName: location.name,
        title: location.title,
        address: location.address,
        websiteUri: location.websiteUri,
        placeId: location.placeId,
        mapsUri: location.mapsUri,
        newReviewUri: location.newReviewUri,
        selectedAt: FieldValue.serverTimestamp(),
        selectedByUid: access.uid,
      },
      // The flat list the listing_shared query reads: this main, then the extras.
      googleLocationNames: [
        location.name,
        ...((snap.data()?.googleExtraListings ?? []) as GoogleListing[])
          .map((l) => l.locationName)
          .filter((n) => n !== location.name),
      ],
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection(`subAccounts/${id}/gbpEvents`).doc(), {
      type: "listing_selected",
      agencyId: pre.sub.agencyId,
      subAccountId: id,
      createdByUid: access.uid,
      at: FieldValue.serverTimestamp(),
      locationName: location.name,
      previousLocationName: previous,
    });
    return changed;
  });
  if (changed === "already_extra") {
    return gbpRefusal(409, "already_extra", "That listing is connected as an extra listing — remove it there first.");
  }
  // A different main listing starts empty: the previous main's cache goes
  // (the main scope — extra listings' caches are untouched).
  if (changed) await clearGbpCache(id);
  // Auto-reply was on and this switched it off: one alert (the card's note).
  if (switchedOff) await sendAutoReplyAlert(id, { kind: "listing_changed" });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  // Extras always sit beside a main listing: remove them first. (Disconnect
  // still clears everything; an extra added after this read is cleared with
  // the main by clearListing.)
  const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data() ?? {};
  if (extraLocationNames(sub).length > 0) {
    return gbpRefusal(409, "has_extra_listings", "Remove the additional listings first.");
  }
  await clearListing(id, access.uid, "admin_cleared");
  return NextResponse.json({ ok: true });
}
