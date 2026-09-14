import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { resolveReviewUrl, type ReviewUrlSource } from "@/lib/reviews/canonical-url";
import { isHttpsUrl } from "@/lib/reviews/review-url";
import { verifyReviewClickToken } from "@/lib/reviews/click-token";

/**
 * One visit to `/rr/{token}` (SP5 d2): the destination for the 302, or null
 * for a 404. The destination is the sub-account's configured review URL as it
 * is NOW, re-checked as https — never a URL carried in the link, so this can
 * not become an open redirect. The first click stamps `clickedAt` on the
 * request, which is what stops its reminders; later clicks keep that time.
 */
export async function resolveReviewClick(token: string): Promise<string | null> {
  const verified = verifyReviewClickToken(token);
  if (!verified) return null;
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${verified.subAccountId}/reviewRequests/${verified.requestId}`);
  const [requestSnap, subSnap] = await Promise.all([ref.get(), db.doc(`subAccounts/${verified.subAccountId}`).get()]);
  const req = requestSnap.data();
  if (!req || req.tracked !== true) return null;
  const destination = resolveReviewUrl(subSnap.data() as ReviewUrlSource | undefined).configured;
  if (!destination || !isHttpsUrl(destination)) return null;

  await db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (current && !current.clickedAt) tx.update(ref, { clickedAt: FieldValue.serverTimestamp() });
  });
  return destination;
}
