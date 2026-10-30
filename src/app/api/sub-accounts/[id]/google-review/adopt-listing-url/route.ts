import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { isMain, locId, locationNamesOf } from "@/lib/gbp/listings";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import { DEFAULT_REVIEW_COOLDOWN_DAYS, DEFAULT_REVIEW_SMS_TEMPLATE, activeReminder } from "@/lib/reviews/constants";
import { googleLinkRefusal } from "@/lib/reviews/reminder-refusal";
import { isHttpsUrl } from "@/lib/reviews/review-url";
import type { SubAccountDoc } from "@/types";
import type { GoogleReviewConfig } from "@/types/tenancy";

/**
 * POST /api/sub-accounts/[id]/google-review/adopt-listing-url
 * body `{ expectedCurrentUrl: string | null }` — the configured review link
 * the admin was looking at.
 *
 * The ONLY way the selected GBP listing's `newReviewUri` becomes the review
 * link senders use. Admin, agency-gated. Compare-and-set in one transaction:
 * set `googleReviewConfig.reviewUrl` to the listing's link only if the
 * configured URL is still `expectedCurrentUrl`, else 409 `changed` with the
 * current one — never a silent overwrite. No config yet → created with the
 * config route's defaults (auto-send OFF). Audited as `review_url_adopted`.
 *
 * Optional `locationName` (MULTI_LISTING_V1_PLAN.md PR 5) — one of this
 * sub-account's listings, else 400 `unknown_listing`. The main listing (or
 * none) is exactly the above. An EXTRA listing's link goes to
 * `googleReviewConfig.listingUrls[locId]`, compare-and-set on THAT value;
 * a config created this way has an empty main `reviewUrl`. Extra-listing
 * sends carry no reminders, so the reminders-on Google-link rule is main-only.
 */

export const dynamic = "force-dynamic";

type Outcome =
  | { ok: true; url: string }
  | { ok: false; code: "unknown_listing" }
  | { ok: false; code: "no_proposal" }
  | { ok: false; code: "changed"; currentUrl: string | null }
  | { ok: false; code: "not_google"; url: string };

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) {
    return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  }
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const expected = raw && typeof raw === "object" ? raw.expectedCurrentUrl : undefined;
  if (expected !== null && typeof expected !== "string") {
    return gbpRefusal(400, "invalid_body", "Send expectedCurrentUrl: the review link you saw, or null.");
  }
  const locationName = raw?.locationName ?? null;
  if (locationName !== null && typeof locationName !== "string") {
    return gbpRefusal(400, "invalid_body", "locationName must be one of this sub-account's listings.");
  }

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${id}`);
  const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
    const sub = ((await tx.get(subRef)).data() ?? {}) as SubAccountDoc;
    if (locationName !== null && !locationNamesOf(sub).includes(locationName)) return { ok: false, code: "unknown_listing" };
    const extra = locationName !== null && !isMain(sub, locationName) ? locationName : null;
    const { configured, proposed } = resolveReviewUrl(sub, locationName);
    if (!proposed || !isHttpsUrl(proposed)) return { ok: false, code: "no_proposal" };
    if (configured !== expected) return { ok: false, code: "changed", currentUrl: configured };
    // SP5 d2: while reminders are on, the link must stay a Google review link.
    if (!extra && activeReminder(sub.googleReviewConfig?.reminder) && googleLinkRefusal(proposed)) {
      return { ok: false, code: "not_google", url: proposed };
    }

    const now = new Date();
    const urlField = extra ? `googleReviewConfig.listingUrls.${locId(extra)}` : "googleReviewConfig.reviewUrl";
    if (sub.googleReviewConfig) {
      tx.update(subRef, { [urlField]: proposed, "googleReviewConfig.updatedAt": now, updatedAt: now });
    } else {
      const cfg: GoogleReviewConfig = {
        enabled: false,
        reviewUrl: extra ? "" : proposed,
        ...(extra ? { listingUrls: { [locId(extra)]: proposed } } : {}),
        channel: "sms",
        messageTemplate: DEFAULT_REVIEW_SMS_TEMPLATE,
        whatsappTemplateId: null,
        cooldownDays: DEFAULT_REVIEW_COOLDOWN_DAYS,
        triggerOnQuotePaid: false,
        triggerOnDealCompleted: false,
        updatedAt: now,
      };
      tx.set(subRef, { googleReviewConfig: cfg, updatedAt: now }, { merge: true });
    }
    tx.set(db.collection(`subAccounts/${id}/gbpEvents`).doc(), {
      type: "review_url_adopted", agencyId: sub.agencyId, subAccountId: id, createdByUid: access.uid,
      actorUid: access.uid, previousUrl: configured, url: proposed, at: now,
      ...(locationName !== null ? { locationName } : {}),
    });
    return { ok: true, url: proposed };
  });

  if (outcome.ok) return NextResponse.json({ ok: true, reviewUrl: outcome.url });
  if (outcome.code === "not_google") return googleLinkRefusal(outcome.url)!;
  if (outcome.code === "changed") {
    return NextResponse.json(
      { error: "The review link changed since you looked — check it and try again.", code: "changed", currentUrl: outcome.currentUrl },
      { status: 409 },
    );
  }
  if (outcome.code === "unknown_listing") {
    return gbpRefusal(400, "unknown_listing", "That listing is not one of this sub-account's.");
  }
  return gbpRefusal(409, "no_proposal", "The selected Google listing has no usable review link.");
}
