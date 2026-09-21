import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { gbpRefusal } from "@/lib/gbp/route-support";
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
 */

export const dynamic = "force-dynamic";

type Outcome =
  | { ok: true; url: string }
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

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${id}`);
  const outcome = await db.runTransaction(async (tx): Promise<Outcome> => {
    const sub = ((await tx.get(subRef)).data() ?? {}) as SubAccountDoc;
    const { configured, proposed } = resolveReviewUrl(sub);
    if (!proposed || !isHttpsUrl(proposed)) return { ok: false, code: "no_proposal" };
    if (configured !== expected) return { ok: false, code: "changed", currentUrl: configured };
    // SP5 d2: while reminders are on, the link must stay a Google review link.
    if (activeReminder(sub.googleReviewConfig?.reminder) && googleLinkRefusal(proposed)) {
      return { ok: false, code: "not_google", url: proposed };
    }

    const now = new Date();
    if (sub.googleReviewConfig) {
      tx.update(subRef, { "googleReviewConfig.reviewUrl": proposed, "googleReviewConfig.updatedAt": now, updatedAt: now });
    } else {
      const cfg: GoogleReviewConfig = {
        enabled: false,
        reviewUrl: proposed,
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
  return gbpRefusal(409, "no_proposal", "The selected Google listing has no usable review link.");
}
