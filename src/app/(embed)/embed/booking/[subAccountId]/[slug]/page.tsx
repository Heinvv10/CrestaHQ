import { notFound } from "next/navigation";
import { getAdminDb } from "@/lib/firebase/admin";
import { PublicBookingView } from "@/components/booking/public-booking-view";
import { publicBookingBranding, publicBookingPage } from "@/lib/booking/public-page";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Embeddable booking widget — the iframe target loaded by the
 * `/booking-embed.js` snippet on a buyer's website. Same data + booking
 * flow as /b/[subAccountId]/[slug] (fetched the same way, same 404-on-
 * unpublished gate); the only difference is `embedded` on
 * PublicBookingView, which drops the full-viewport chrome so the iframe's
 * natural height matches its content for the loader's auto-resize.
 */

interface PageProps {
  params: Promise<{ subAccountId: string; slug: string }>;
}

export default async function EmbedBookingPage({ params }: PageProps) {
  const { subAccountId, slug } = await params;
  const db = getAdminDb();

  const [pageSnap, subSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}/bookingPages/${slug}`).get(),
    db.doc(`subAccounts/${subAccountId}`).get(),
  ]);
  if (!pageSnap.exists || !subSnap.exists) notFound();

  const page = pageSnap.data() as BookingPage;
  if (page.status !== "published") notFound();

  const sub = subSnap.data() as SubAccountDoc;

  // Only what these builders pick is sent to the client (see /b's page).
  const branding = publicBookingBranding(sub, page, "Schedule a meeting");

  return (
    <PublicBookingView
      subAccountId={subAccountId}
      page={publicBookingPage(page)}
      branding={branding}
      embedded
    />
  );
}
