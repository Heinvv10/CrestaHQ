import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import { hashEventToken, verifyEventToken } from "@/lib/booking/event-token";
import { PublicEventView } from "@/components/booking/public-event-view";
import {
  publicBookingBranding,
  publicEventData,
} from "@/lib/booking/public-page";
import { validateSlug } from "@/lib/booking/validation";
import { isDocId } from "@/lib/server/doc-id";
import type { BookingPage } from "@/types/booking";
import { isImportedEvent, type CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * Public event-management page. Lets the attendee view their booking
 * details and reschedule / cancel without logging in.
 *
 * Security:
 *   1. HMAC token verified by `verifyEventToken()`.
 *   2. Loaded event's `publicTokenHash` compared against
 *      `hashEventToken(presentedToken)`. Mismatch (e.g. reschedule
 *      rotated, or a forged token) → 404, identical to "not found".
 *
 * Mirrors the /q/[token] quote pattern: server-renders the headline
 * + canonical details so the page is useful before any JS hydrates;
 * the interactive reschedule/cancel UX lands in the client component.
 */

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function PublicEventPage({ params }: PageProps) {
  const { token } = await params;

  const verified = verifyEventToken(token);
  if (!verified) notFound();

  const db = getAdminDb();
  const eventSnap = await db.collection("events").doc(verified.eventId).get();
  if (!eventSnap.exists) notFound();
  const event = eventSnap.data() as CalendarEvent;
  // A member's own Google event never has a visitor page.
  if (isImportedEvent(event)) notFound();
  const presentedHash = hashEventToken(token);
  // Stripe returns the visitor to the token the pay button was pressed on,
  // which confirming the payment rotated. That one token gets a read-only
  // receipt; the live link (with reschedule/cancel) is in the confirmation
  // email.
  if (
    event.publicTokenHash !== presentedHash &&
    event.paidFromTokenHash === presentedHash
  ) {
    return <PaymentReceived />;
  }
  if (event.publicTokenHash !== presentedHash) notFound();
  const slugCheck = validateSlug(event.bookingPageSlug);
  if (
    !isDocId(event.subAccountId) ||
    !slugCheck.ok ||
    slugCheck.value !== event.bookingPageSlug
  )
    notFound();

  const [subSnap, pageSnap] = await Promise.all([
    db.doc(`subAccounts/${event.subAccountId}`).get(),
    db
      .doc(`subAccounts/${event.subAccountId}/bookingPages/${slugCheck.value}`)
      .get(),
  ]);
  if (!subSnap.exists) notFound();
  const sub = subSnap.data() as SubAccountDoc;
  const page = (pageSnap.exists ? pageSnap.data() : null) as BookingPage | null;

  let startAt: Date | undefined;
  let endAt: Date | undefined;
  try {
    startAt = (event.startAt as { toDate?: () => Date } | null)?.toDate?.();
    endAt = (event.endAt as { toDate?: () => Date } | null)?.toDate?.();
  } catch {
    notFound();
  }
  if (
    !startAt ||
    !endAt ||
    !Number.isFinite(startAt.getTime()) ||
    !Number.isFinite(endAt.getTime()) ||
    endAt <= startAt
  )
    notFound();

  // Only what this builder picks is sent to the client.
  const branding = publicBookingBranding(sub, page, "Booking");
  const publicEvent = publicEventData(event, page, startAt, endAt);

  return (
    <PublicEventView
      token={token}
      subAccountId={event.subAccountId}
      eventId={verified.eventId}
      status={publicEvent.status}
      title={publicEvent.title}
      pageName={publicEvent.pageName}
      pageSlug={slugCheck.value}
      bookingPageStatus={publicEvent.bookingPageStatus}
      timezone={publicEvent.timezone}
      durationMinutes={publicEvent.durationMinutes}
      startAt={startAt.toISOString()}
      endAt={endAt.toISOString()}
      paymentLinkUrl={publicEvent.paymentLinkUrl}
      paymentAmount={publicEvent.paymentAmount}
      paymentCurrency={publicEvent.paymentCurrency}
      // Payments v1 — card deposit is offered only when the agency gate is on
      // AND the Stripe connection can confirm payments. An unfinished webhook
      // would leave the slot held after a successful payment, so hide it.
      cardPayEnabled={
        (sub as { paymentsEnabledByAgency?: boolean })
          .paymentsEnabledByAgency === true &&
        (sub as { stripeConnectionMeta?: { ready?: boolean } | null })
          .stripeConnectionMeta?.ready === true
      }
      branding={branding}
    />
  );
}

function PaymentReceived() {
  return (
    <main className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Payment received</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Your booking is confirmed. We&apos;ve emailed you the confirmation with
        a link to manage it.
      </p>
    </main>
  );
}
