import { notFound } from "next/navigation";
import { getAdminDb } from "@/lib/firebase/admin";
import { PublicBookingView } from "@/components/booking/public-booking-view";
import {
  publicBookingBranding,
  publicBookingPage,
} from "@/lib/booking/public-page";
import { validateSlug } from "@/lib/booking/validation";
import { isDocId } from "@/lib/server/doc-id";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Public booking page — what visitors land on. Server-rendered via the
 * Admin SDK so we can keep Firestore rules member-only on the booking
 * page doc + parent sub-account (no public-read carve-out needed).
 *
 * Treats missing + draft pages identically (404) so we don't leak the
 * existence of unpublished pages. Sub-account doc is fetched for
 * branding (logoUrl, name) — falls back to the booking page's overrides
 * when set.
 *
 * The interactive picker + intake form mount as a client component
 * (PublicBookingView). All availability + booking POSTs flow through
 * the public /api/booking/[saId]/[slug]/* routes.
 */

interface PageProps {
  params: Promise<{ subAccountId: string; slug: string }>;
}

export default async function PublicBookingPage({ params }: PageProps) {
  const { subAccountId, slug } = await params;
  const slugCheck = validateSlug(slug);
  if (!isDocId(subAccountId) || !slugCheck.ok || slugCheck.value !== slug)
    notFound();
  const db = getAdminDb();

  const [pageSnap, subSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}/bookingPages/${slug}`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  if (!pageSnap.exists || !subSnap.exists) notFound();

  const page = pageSnap.data() as BookingPage;
  if (page.status !== "published") notFound();

  const sub = subSnap.data() as SubAccountDoc;

  // Only what these builders pick is sent to the client: Next writes every
  // prop into the response, so the stored docs themselves never leave here.
  const branding = publicBookingBranding(sub, page, "Schedule a meeting");

  return (
    <PublicBookingView
      subAccountId={subAccountId}
      page={publicBookingPage(page, slug)}
      branding={branding}
    />
  );
}
