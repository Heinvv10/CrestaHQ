import "server-only";

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { DEAL_STATE_TAG } from "@/lib/landing/deal-cache";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import {
  DEAL_NAME_MAX,
  DEAL_MEMBER_NOUN_MAX,
  DEAL_SEATS_MIN,
  DEAL_SEATS_MAX,
  DEAL_OFFER_LABEL_MAX,
  RETAIL_BANNER_MAX,
  isValidTimeZone,
} from "@/lib/deal-config";

/**
 * Agency-owner-only editor for the live deal campaign (name, urgency type,
 * member noun, seat count, countdown deadline + offer label). Writes onto
 * the EXISTING `appConfig/foundersCohort` doc —
 * publicly readable by the unauthenticated landing page via
 * `useFoundersCohort` — through the Admin SDK (bypasses the
 * `allow write: if false` rule). Mirrors the updates-modal-config route.
 *
 * Deliberately never touches `soldCount` / `currentWave` — those belong to
 * the Stripe webhook. Reset them in the Firebase console when starting a
 * fresh campaign.
 */

const DOC_PATH = "appConfig/foundersCohort";

interface PatchBody {
  dealName?: string;
  dealType?: string;
  memberNoun?: string;
  slotsTotal?: number;
  /** ISO-8601 datetime for the countdown deadline, or null to clear it. */
  dealEndsAt?: string | null;
  /** IANA zone the deadline's wall clock was authored in, or null. */
  dealEndsTimeZone?: string | null;
  offerLabel?: string;
  fullPriceAfterEnd?: boolean;
  /** Master "end all deals" switch → retail $1,782 everywhere. */
  retailMode?: boolean;
  /** Announcement-bar copy shown while `retailMode` is on. */
  retailBannerMessage?: string;
}

export async function PATCH(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: auth.uid,
  };

  if (body.dealName !== undefined) {
    const dealName =
      typeof body.dealName === "string" ? body.dealName.trim() : "";
    if (!dealName || dealName.length > DEAL_NAME_MAX) {
      return NextResponse.json(
        { error: `\`dealName\` must be 1–${DEAL_NAME_MAX} characters.` },
        { status: 400 },
      );
    }
    updates.dealName = dealName;
  }

  if (body.memberNoun !== undefined) {
    const memberNoun =
      typeof body.memberNoun === "string" ? body.memberNoun.trim() : "";
    if (!memberNoun || memberNoun.length > DEAL_MEMBER_NOUN_MAX) {
      return NextResponse.json(
        {
          error: `\`memberNoun\` must be 1–${DEAL_MEMBER_NOUN_MAX} characters.`,
        },
        { status: 400 },
      );
    }
    updates.memberNoun = memberNoun;
  }

  if (body.dealType !== undefined) {
    if (body.dealType !== "spots" && body.dealType !== "countdown") {
      return NextResponse.json(
        { error: '`dealType` must be "spots" or "countdown".' },
        { status: 400 },
      );
    }
    updates.dealType = body.dealType;
  }

  if (body.dealEndsAt !== undefined) {
    if (body.dealEndsAt === null) {
      updates.dealEndsAt = null;
    } else {
      const ms =
        typeof body.dealEndsAt === "string" ? Date.parse(body.dealEndsAt) : NaN;
      if (!Number.isFinite(ms)) {
        return NextResponse.json(
          { error: "`dealEndsAt` must be an ISO-8601 datetime or null." },
          { status: 400 },
        );
      }
      // Stored as a normalized ISO string (not a Firestore Timestamp) so the
      // public landing's client SDK read needs no type juggling. A past date
      // is allowed — the landing hides the timer but keeps selling.
      updates.dealEndsAt = new Date(ms).toISOString();
    }
  }

  if (body.dealEndsTimeZone !== undefined) {
    if (body.dealEndsTimeZone === null) {
      updates.dealEndsTimeZone = null;
    } else if (
      typeof body.dealEndsTimeZone !== "string" ||
      // Validated against the runtime's own Intl database rather than a
      // hardcoded list, so a zone outside the editor's curated picker
      // (a future addition, an operator-detected zone) still saves.
      !isValidTimeZone(body.dealEndsTimeZone)
    ) {
      return NextResponse.json(
        { error: "`dealEndsTimeZone` must be an IANA timezone id or null." },
        { status: 400 },
      );
    } else {
      updates.dealEndsTimeZone = body.dealEndsTimeZone;
    }
  }

  if (body.fullPriceAfterEnd !== undefined) {
    if (typeof body.fullPriceAfterEnd !== "boolean") {
      return NextResponse.json(
        { error: "`fullPriceAfterEnd` must be a boolean." },
        { status: 400 },
      );
    }
    updates.fullPriceAfterEnd = body.fullPriceAfterEnd;
  }

  if (body.retailMode !== undefined) {
    if (typeof body.retailMode !== "boolean") {
      return NextResponse.json(
        { error: "`retailMode` must be a boolean." },
        { status: 400 },
      );
    }
    updates.retailMode = body.retailMode;
  }

  if (body.retailBannerMessage !== undefined) {
    const retailBannerMessage =
      typeof body.retailBannerMessage === "string"
        ? body.retailBannerMessage.trim()
        : "";
    if (
      !retailBannerMessage ||
      retailBannerMessage.length > RETAIL_BANNER_MAX
    ) {
      return NextResponse.json(
        {
          error: `\`retailBannerMessage\` must be 1–${RETAIL_BANNER_MAX} characters.`,
        },
        { status: 400 },
      );
    }
    updates.retailBannerMessage = retailBannerMessage;
  }

  if (body.offerLabel !== undefined) {
    const offerLabel =
      typeof body.offerLabel === "string" ? body.offerLabel.trim() : "";
    if (!offerLabel || offerLabel.length > DEAL_OFFER_LABEL_MAX) {
      return NextResponse.json(
        {
          error: `\`offerLabel\` must be 1–${DEAL_OFFER_LABEL_MAX} characters.`,
        },
        { status: 400 },
      );
    }
    updates.offerLabel = offerLabel;
  }

  if (body.slotsTotal !== undefined) {
    const s = body.slotsTotal;
    if (
      typeof s !== "number" ||
      !Number.isInteger(s) ||
      s < DEAL_SEATS_MIN ||
      s > DEAL_SEATS_MAX
    ) {
      return NextResponse.json(
        {
          error: `\`slotsTotal\` must be a whole number between ${DEAL_SEATS_MIN} and ${DEAL_SEATS_MAX}.`,
        },
        { status: 400 },
      );
    }
    updates.slotsTotal = s;
  }

  // Require at least one real field beyond the two audit stamps.
  if (Object.keys(updates).length <= 2) {
    return NextResponse.json(
      { error: "No valid fields to update." },
      { status: 400 },
    );
  }

  try {
    await getAdminDb().doc(DOC_PATH).set(updates, { merge: true });
  } catch (err) {
    console.error("[agency/deal-config] write failed", err);
    return NextResponse.json({ error: "Save failed." }, { status: 500 });
  }

  // The landing SERVER-renders this state to keep its first paint
  // price-accurate (see lib/landing/deal-state-server) — bust that cache so
  // a save shows up on the next request instead of after the safety-net
  // window. Live visitors already see it instantly via onSnapshot.
  revalidateTag(DEAL_STATE_TAG);

  return NextResponse.json({ ok: true });
}
