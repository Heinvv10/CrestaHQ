import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import { verifyReviewToken } from "@/lib/reviews/feedback-token";
import { PublicReviewView } from "@/components/reviews/public-review-view";
import { LogoMark } from "@/components/brand/logo-mark";

/**
 * Public review + feedback page.
 *
 * Two-step verification, same as the public quote page:
 *   1. The token's HMAC signature must check out.
 *   2. The loaded contact's `reviewTokenHash` must equal the hash of the
 *      presented token — so a re-send invalidates the old link.
 *
 * ── COMPLIANCE, READ BEFORE EDITING ────────────────────────────────────────
 * The Google review link is rendered for EVERY visitor, unconditionally, and
 * it is the primary call to action ABOVE the rating control. Nothing on this
 * page branches on the customer's rating.
 *
 * Google's Maps user-generated-content policy prohibits "review gating" —
 * showing the review link only to happy customers and routing unhappy ones to
 * a private form. Google began enforcing this with the April 2026 policy
 * update; the penalties are review removal and reduced profile visibility.
 *
 * Do not make `reviewUrl` conditional on `rating`. Do not hide it behind a
 * "were you happy?" step. If a client asks for that, the answer is no.
 * ───────────────────────────────────────────────────────────────────────────
 */
export default async function PublicReviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const verified = verifyReviewToken(token);
  if (!verified) notFound();

  const db = getAdminDb();
  const snap = await db.doc(`contacts/${verified.contactId}`).get();
  if (!snap.exists) notFound();

  const contact = snap.data() as Record<string, unknown>;
  if (contact.reviewTokenHash !== verified.hash) notFound();

  const subAccountId =
    typeof contact.subAccountId === "string" ? contact.subAccountId : "";
  if (!subAccountId) notFound();

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = (subSnap.data() ?? {}) as Record<string, unknown>;
  const cfg = (sub.googleReview ?? {}) as Record<string, unknown>;

  const reviewUrl = typeof cfg.reviewUrl === "string" ? cfg.reviewUrl : "";
  const businessName =
    (typeof sub.name === "string" && sub.name) || "our team";
  const firstName =
    typeof contact.name === "string" ? contact.name.split(" ")[0]! : "";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-8 px-5 py-12">
      <header className="flex justify-center">
        <LogoMark />
      </header>
      <PublicReviewView
        token={token}
        firstName={firstName}
        businessName={businessName}
        reviewUrl={reviewUrl}
      />
    </main>
  );
}
