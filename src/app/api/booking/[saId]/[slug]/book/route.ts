import "server-only";
import { canTakePayment } from "@/lib/payments/can-take-payment";

import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  emailIsConfigured,
  sendEmail,
  tenantFrom,
} from "@/lib/comms/resend";
import { recordSuppressedEmail } from "@/lib/comms/email-suppression";
import { buildPaypalAmountUrl } from "@/lib/paypal/payment-link";
import { isSlotAvailable, type SlotCandidate } from "@/lib/booking/availability";
import { isSafeFormRedirectUrl } from "@/lib/forms/redirect-url";
import {
  bookedEventLabel,
  pageCalendarType,
} from "@/lib/booking/calendar-types";
import {
  assignBookingHosts,
  pageService,
  selectableHostUid,
} from "@/lib/booking/page-slots";
import { resolvePageAvailability } from "@/lib/booking/resolve-availability";
import { loadGoogleBusyForPage } from "@/lib/google-calendar/busy";
import {
  pushBookingAndGetMeetUrl,
  pushBookingToGoogleAfterResponse,
} from "@/lib/google-calendar/push";
import {
  LOCATION_ADDRESS_MAX,
  effectiveBookingLocation,
  eventLocationText,
  isPlainLocationText,
} from "@/lib/booking/location";
import { bookingRateLimitsDisabled } from "@/lib/booking/rate-limit-e2e";
import {
  loadHostNotifyContact,
  loadHostUpcomingCounts,
} from "@/lib/booking/hosts";
import {
  buildEventPublicUrl,
  issueEventToken,
} from "@/lib/booking/event-token";
import { generateIcs } from "@/lib/booking/ics";
import { reconcileBookingContact } from "@/lib/booking/contact-reconcile";
import {
  emitBookingWebhook,
  fireBookingTrigger,
  recordBookingActivity,
  schedulePaymentAutoExpire,
  scheduleEventReminders,
} from "@/lib/booking/lifecycle";
import {
  renderBookingConfirmationEmail,
  renderBookingHostNotificationEmail,
  renderBookingPaymentPendingEmail,
} from "@/lib/booking/email";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types/tenancy";
import { isDocId } from "@/lib/server/doc-id";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Public booking submission. Unauthenticated; security comes from:
 *  - the per-page slot-availability re-check inside a Firestore
 *    transaction (no double-book even on a stale UI),
 *  - per-IP + per-sub-account rate limits,
 *  - the BookingPage `status` gate (drafts return 404 same as
 *    availability),
 *  - validated intake payload (mandatory name/email/phone + per-page
 *    custom field rules).
 *
 * On success:
 *  - reconciles a Contact (email-match within the sub-account; new
 *    contacts stamp `source: "booking-page"` + the page's
 *    `defaultTerritoryId`),
 *  - creates an `events/{id}` doc carrying full booking metadata
 *    (status, source, bookingPageSlug, publicTokenHash, payment fields
 *    when applicable),
 *  - mints + persists an HMAC public token (raw token only ever in the
 *    outbound email URL),
 *  - sends a confirmation OR payment-pending email via tenantFrom (uses
 *    the sub-account's verified sending domain when configured),
 *  - schedules QStash reminder callbacks (T-24h + T-1h) for scheduled
 *    bookings, or the auto-expire callback for awaiting-payment holds,
 *  - fires the `booking.created` workflow trigger, plus `booking.confirmed`
 *    for a free (non-paid-hold) booking — see lib/booking/lifecycle.ts.
 */

// ── Soft rate limits (per IP + per sub-account, in-memory LRU) ──
// Skipped entirely when bookingRateLimitsDisabled() is true (E2E only).
const IP_HOURLY_CAP = 10;
const SUB_HOURLY_CAP = 100;
const WINDOW_MS = 60 * 60_000;
const ipHits = new Map<string, number[]>();
const subHits = new Map<string, number[]>();

function pushAndCheck(
  bucket: Map<string, number[]>,
  key: string,
  cap: number,
): boolean {
  if (bookingRateLimitsDisabled()) return false;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const arr = (bucket.get(key) ?? []).filter((t) => t >= cutoff);
  if (arr.length >= cap) {
    bucket.set(key, arr);
    return true;
  }
  arr.push(now);
  bucket.set(key, arr);
  if (bucket.size > 5000) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) bucket.delete(oldest);
  }
  return false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SubmittedSlot {
  startAt?: string;
  endAt?: string;
}

interface BookBody {
  slot?: SubmittedSlot;
  name?: string;
  email?: string;
  phone?: string;
  extras?: Record<string, string>;
  /** Optional requested host (named-host selection). Honoured only on pages
   *  with `allowHostSelection` on; ignored otherwise. */
  hostUid?: string;
  /** Service pages: the service the visitor picked. Required there. */
  serviceId?: string;
  /** "At their place" pages: where the visit happens. Required there. */
  address?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ saId: string; slug: string }> },
) {
  const { saId, slug } = await ctx.params;
  const ip = clientIpFrom(request);
  if (pushAndCheck(ipHits, ip, IP_HOURLY_CAP)) {
    return NextResponse.json(
      { error: "Too many booking attempts. Try again later." },
      { status: 429 },
    );
  }
  if (pushAndCheck(subHits, saId, SUB_HOURLY_CAP)) {
    return NextResponse.json(
      { error: "Booking page is busy. Try again later." },
      { status: 429 },
    );
  }

  // Up to 10 intake answers of 2,000 characters (~80 KB if every one is
  // 4-byte UTF-8) plus contact fields: 128 KB.
  const read = await readJsonCapped(request, 128 * 1024);
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json({ error: "Request body too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = (read.value ?? {}) as BookBody;

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const phone = (body.phone ?? "").trim();
  if (!name || name.length > 120) {
    return NextResponse.json(
      { error: "Name is required (max 120 chars)." },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(email) || email.length > 200) {
    return NextResponse.json(
      { error: "A valid email is required." },
      { status: 400 },
    );
  }
  if (!phone || phone.length > 40) {
    return NextResponse.json(
      { error: "Phone is required." },
      { status: 400 },
    );
  }
  const slot = body.slot;
  if (!slot?.startAt || !slot?.endAt) {
    return NextResponse.json(
      { error: "Pick a time before booking." },
      { status: 400 },
    );
  }
  const slotStart = new Date(slot.startAt);
  const slotEnd = new Date(slot.endAt);
  if (
    Number.isNaN(slotStart.getTime()) ||
    Number.isNaN(slotEnd.getTime()) ||
    slotEnd <= slotStart
  ) {
    return NextResponse.json(
      { error: "Selected slot is invalid." },
      { status: 400 },
    );
  }

  if (!isDocId(saId) || !isDocId(slug)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const db = getAdminDb();
  const pageSnap = await db
    .doc(`subAccounts/${saId}/bookingPages/${slug}`)
    .get();
  if (!pageSnap.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const page = pageSnap.data() as BookingPage;
  if (page.status !== "published") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Where the meeting happens. "At their place" needs the booker's address;
  // "we call you" uses the phone above.
  const pageLocation = effectiveBookingLocation(page);
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (
    pageLocation?.type === "their_address" &&
    (!address || address.length > LOCATION_ADDRESS_MAX || !isPlainLocationText(address))
  ) {
    return NextResponse.json(
      { error: "Please enter the address for the visit (one line, no < or >)." },
      { status: 400 },
    );
  }
  const locationText = eventLocationText(pageLocation, {
    phone,
    address: pageLocation?.type === "their_address" ? address : null,
  });

  // Validate page-defined required intake fields. (UI also enforces.)
  const extras: Record<string, string> = {};
  for (const f of page.intakeFields) {
    const raw = body.extras?.[f.id];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (f.required && !value) {
      return NextResponse.json(
        { error: `Please answer: ${f.label}` },
        { status: 400 },
      );
    }
    if (value.length > 2000) {
      return NextResponse.json(
        { error: `Answer too long for "${f.label}"` },
        { status: 400 },
      );
    }
    if (f.type === "select" && value) {
      if (!(f.options ?? []).includes(value)) {
        return NextResponse.json(
          { error: `Invalid option for "${f.label}"` },
          { status: 400 },
        );
      }
    }
    if (value) extras[f.id] = value;
  }

  const subSnap = await db.doc(`subAccounts/${saId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account missing" }, { status: 500 });
  }
  const sub = subSnap.data() as SubAccountDoc;
  const agencyId = sub.agencyId;

  // Payment gate is only honoured when the sub-account can actually collect
  // (card OR paypal.me). Defense in depth: the editor also rejects payment
  // configs with no rail, but config drift shouldn't let a visitor land on a
  // "Pay" button that doesn't exist.
  //
  // This USED to test `sub.paypalConfig` alone, which meant a Stripe-only
  // workspace silently booked paid slots for free — paymentRequired was false,
  // so the deposit was skipped entirely.
  const paymentRequired = !!page.payment && canTakePayment(sub);

  // Service pages: the visitor's service sizes the slot (the re-verify below
  // only matches a slot of that service's length) and is stamped on the event.
  const calendarType = pageCalendarType(page);
  const service = pageService(page, body.serviceId);
  if (calendarType === "service" && !service) {
    return NextResponse.json(
      { error: "Pick a service before booking." },
      { status: 400 },
    );
  }
  // Emails, invite and title name the service and its own length.
  const { name: bookedName, durationMinutes } = bookedEventLabel(
    page,
    { serviceName: service?.name ?? null },
    slotStart,
    slotEnd,
  );

  // ── Transactional create with re-verify ─────────────────────────
  // Re-resolve availability around the requested slot inside the
  // transaction, and only write if the slot survives. A visitor on a
  // stale UI gets 409, not a double-booked event.
  const eventsRef = db.collection("events");
  const eventDocRef = eventsRef.doc(); // pre-allocate id for token mint
  const now = new Date();

  // Named-host selection: honour a requested host ONLY on opted-in pages, and
  // only when it names a real host. Otherwise fall through to pooled
  // assignment (a forged/unknown hostUid can't change behaviour).
  const selectedHostUid = selectableHostUid(
    page,
    (body.hostUid ?? "").trim() || null,
  );
  // Round-robin load, read OUTSIDE the transaction (slightly stale is fine).
  const hosts = page.hosts ?? [];
  const loadByHost =
    hosts.length > 0 &&
    (calendarType === "round_robin" || calendarType === "service")
      ? await loadHostUpcomingCounts(
          saId,
          hosts.map((h) => h.uid),
          now,
        )
      : new Map<string, number>();
  // Hosts' Google busy (SP3 G2), loaded BEFORE the transaction; fail open.
  const externalBusy = await loadGoogleBusyForPage({
    subAccountId: saId,
    page,
    now,
    fromInstant: new Date(slotStart.getTime() - 1),
    toInstant: new Date(slotEnd.getTime() + 1),
  });

  type CreatedPayload = {
    eventDocRef: FirebaseFirestore.DocumentReference;
    territoryId: string;
    contactId: string;
    contactCreated: boolean;
    title: string;
    rawToken: string;
    tokenHash: string;
    paymentLinkUrl: string | null;
    paymentHoldExpiresAt: Date | null;
    assignedToUid: string | null;
    assignedToName: string | null;
    hostUids: string[] | null;
  };

  let created: CreatedPayload;
  try {
    created = await db.runTransaction(async (txn) => {
      // The same resolver the visitor's slot list came from, so the
      // re-verify can't disagree with what was shown. When the customer
      // picked a specific person, only that host is a candidate — never
      // silently reassign to someone else.
      const free = await resolvePageAvailability({
        subAccountId: saId,
        page,
        now,
        fromInstant: new Date(slotStart.getTime() - 1),
        toInstant: new Date(slotEnd.getTime() + 1),
        onlyHostUid: selectedHostUid,
        serviceId: service?.id ?? null,
        externalBusy,
        txn,
      });
      const candidate: SlotCandidate = { startAt: slotStart, endAt: slotEnd };
      const slotMatch = free.find((s) => isSlotAvailable(candidate, [s]));
      const assignment = slotMatch
        ? assignBookingHosts(page, slotMatch, loadByHost)
        : null;
      if (!assignment) throw new SlotConflict();
      const { assignedToUid, assignedToName } = assignment;

      // Reconcile the contact OUTSIDE the txn would be ideal (Admin SDK
      // queries inside a txn lock the read set), but the email-equality
      // query is cheap and the txn is short. Keep it inside so we don't
      // need a compensating delete on a downstream failure.
      const reconciled = await reconcileBookingContact({
        agencyId,
        subAccountId: saId,
        email,
        name,
        phone,
        phoneCountry: sub.defaultPhoneCountry ?? null,
        defaultTerritoryId: page.defaultTerritoryId,
        txn,
      });

      const territoryId =
        page.defaultTerritoryId && page.defaultTerritoryId.length > 0
          ? page.defaultTerritoryId
          : GLOBAL_TERRITORY_ID;

      const status = paymentRequired ? "awaiting_payment" : "scheduled";
      let paymentLinkUrl: string | null = null;
      let paymentHoldExpiresAt: Date | null = null;
      if (paymentRequired && page.payment) {
        // The hold window is a property of the PAGE, not of the payment rail.
        // It used to be set only inside the paypal branch below, which meant a
        // Stripe-only workspace produced a hold with no expiry — the
        // auto-expire step is gated on this field, so the slot would stay
        // locked forever when the deposit went unpaid.
        paymentHoldExpiresAt = new Date(
          now.getTime() + page.payment.holdHours * 60 * 60_000,
        );
        // paypal.me link only when PayPal is configured. Card deposits need no
        // pre-minted URL — the button on /e/[token] creates a Stripe session
        // on demand.
        if (sub.paypalConfig) {
          paymentLinkUrl = buildPaypalAmountUrl({
            paypal: sub.paypalConfig,
            amount: page.payment.amount,
            currency: page.payment.currency,
          });
        }
      }

      const title = `${bookedName} — ${name}`;
      // Mint token now so we can store hash atomically.
      const { token, hash } = issueEventToken(eventDocRef.id);

      // Build the event doc. All new fields are optional in the type so
      // unused ones land as `null` cleanly.
      const eventDoc = {
        id: eventDocRef.id,
        title,
        startAt: slotStart,
        endAt: slotEnd,
        contactId: reconciled.id,
        location: locationText,
        // Snapshot the page's meeting URL onto the event so a later edit
        // to the page doesn't rewrite historical invites.
        meetingUrl: page.meetingUrl ?? null,
        notes: extras
          ? Object.entries(extras)
              .map(([k, v]) => `${labelForField(page, k)}: ${v}`)
              .join("\n")
          : "",
        agencyId,
        subAccountId: saId,
        createdByUid: "booking-page",
        territoryId,
        status,
        source: "booking_page",
        bookingPageSlug: page.slug,
        publicTokenHash: hash,
        paymentRequired,
        paymentAmount: page.payment?.amount ?? null,
        paymentCurrency: page.payment?.currency ?? null,
        paymentLinkUrl,
        paidAt: null,
        paidByUid: null,
        paymentHoldExpiresAt,
        assignedToUid,
        assignedToName,
        // Collective / service extras — absent on every other booking.
        ...(assignment.hostUids ? { hostUids: assignment.hostUids } : {}),
        ...(service ? { serviceId: service.id, serviceName: service.name } : {}),
        cancelledAt: null,
        cancelledByVisitor: null,
        cancelReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      txn.set(eventDocRef, eventDoc);

      return {
        eventDocRef,
        territoryId,
        contactId: reconciled.id,
        contactCreated: reconciled.created,
        title,
        rawToken: token,
        tokenHash: hash,
        paymentLinkUrl,
        paymentHoldExpiresAt,
        assignedToUid,
        assignedToName,
        hostUids: assignment.hostUids,
      };
    });
  } catch (err) {
    if (err instanceof SlotConflict) {
      return NextResponse.json(
        {
          error:
            "That slot was just taken. Refresh the page and pick another time.",
        },
        { status: 409 },
      );
    }
    console.error("[booking/book] transaction failed", err);
    return NextResponse.json(
      { error: "Couldn't reserve the slot. Try again." },
      { status: 500 },
    );
  }

  // ── Post-write side effects (best-effort) ──────────────────────
  const publicEventUrl = buildEventPublicUrl(created.rawToken);
  const appHost =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, "")
      ?.replace(/\/.*$/, "")
      ?.toLowerCase() ?? "leadstack.dev";

  // Google Meet: the confirmation carries the booking's own Meet link, so the
  // push runs BEFORE the email, not after the response. The booking is
  // already committed — a push that fails or makes no room only means the
  // page's fallback link (or none) goes out. A paid hold confirms later
  // (mark-paid), so its push stays after the response.
  const meetPushNow = pageLocation?.type === "google_meet" && !paymentRequired;
  let meetingUrl = page.meetingUrl ?? null;
  if (meetPushNow) {
    const pushed = await pushBookingAndGetMeetUrl(created.eventDocRef.id);
    if (pushed.meetUrl) meetingUrl = pushed.meetUrl;
  }
  // No Meet room and no fallback link: say so instead of a bare "Google Meet".
  const meetLinkMissing = meetPushNow && !meetingUrl;
  const bookerLocation = meetLinkMissing
    ? `${locationText} (the joining link will follow)`
    : locationText;

  // Confirmation / payment-pending email.
  if (emailIsConfigured(sub)) {
    try {
      const rendered = paymentRequired
        ? renderBookingPaymentPendingEmail({
            recipientName: name,
            businessName: sub.name ?? "Booking",
            businessLogoUrl: sub.logoUrl,
            page: {
              name: bookedName,
              durationMinutes,
              timezone: page.timezone,
              payment: page.payment,
              confirmationMessage: page.confirmationMessage,
            },
            startAt: slotStart,
            endAt: slotEnd,
            publicEventUrl,
            paymentUrl: created.paymentLinkUrl,
          })
        : renderBookingConfirmationEmail({
            recipientName: name,
            businessName: sub.name ?? "Booking",
            businessLogoUrl: sub.logoUrl,
            page: {
              name: bookedName,
              durationMinutes,
              timezone: page.timezone,
              payment: page.payment,
              confirmationMessage: page.confirmationMessage,
            },
            startAt: slotStart,
            endAt: slotEnd,
            meetingUrl,
            location: bookerLocation || undefined,
            publicEventUrl,
            // Name the host the customer chose (null in single/pooled mode).
            hostName: created.assignedToName,
          });

      // ICS only for confirmed bookings (not awaiting_payment) so we
      // don't pollute attendee calendars with holds.
      const attachments = !paymentRequired
        ? buildIcsAttachment({
            eventId: created.eventDocRef.id,
            startAt: slotStart,
            endAt: slotEnd,
            domain: appHost,
            title: created.title,
            // Name the chosen host in the calendar invite body too.
            description: [
              page.confirmationMessage || "",
              created.assignedToName ? `With ${created.assignedToName}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            // Calendar apps render a clickable "Join" affordance when
            // LOCATION is a URL — Zoom / Meet / Whereby all auto-detect.
            location: meetingUrl || bookerLocation,
            organizerEmail: sub.replyToEmail ?? undefined,
            organizerName: sub.name ?? undefined,
            attendeeEmail: email,
            attendeeName: name,
          })
        : undefined;

      await sendEmailWithIcs({
        to: email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: sub.replyToEmail ?? undefined,
        from: tenantFrom(sub),
        subAccount: sub,
        icsAttachment: attachments,
        meterSubAccountId: saId,
      });
    } catch (err) {
      const suppressed = await recordSuppressedEmail(err, {
        contactId: created.contactId,
        eventId: created.eventDocRef.id,
        what: "Booking confirmation",
        createdBy: "booking",
      });
      if (!suppressed) console.warn("[booking/book] confirmation send failed", err);
    }
  }

  // Notify the assigned host — team-mode confirmed bookings only. Best-effort:
  // a missing host email or a send failure never affects the visitor's
  // confirmed booking. Skipped for unpaid holds (notify on the actual
  // confirmation, i.e. when the slot isn't payment-pending). A collective
  // booking notifies every host in the meeting.
  if (
    !paymentRequired &&
    created.assignedToUid &&
    created.assignedToName &&
    emailIsConfigured(sub)
  ) {
    for (const hostUid of created.hostUids ?? [created.assignedToUid]) {
      try {
        const hostContact = await loadHostNotifyContact(saId, hostUid);
        if (hostContact) {
          const rendered = renderBookingHostNotificationEmail({
            hostName: hostContact.name,
            businessName: sub.name ?? "Booking",
            businessLogoUrl: sub.logoUrl,
            page: {
              name: bookedName,
              durationMinutes,
              timezone: page.timezone,
            },
            startAt: slotStart,
            endAt: slotEnd,
            customerName: name,
            customerEmail: email,
            customerPhone: phone,
            notes:
              [
                locationText ? `Where: ${locationText}` : "",
                meetLinkMissing
                  ? "No Google Meet link could be made for this booking (check Settings → Calendar sync) — send the customer a joining link."
                  : "",
                ...Object.entries(extras).map(
                  ([k, v]) => `${labelForField(page, k)}: ${v}`,
                ),
              ]
                .filter(Boolean)
                .join("\n") || null,
            manageUrl: publicEventUrl,
          });
          await sendEmail({
            archive: false,
            to: hostContact.email,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            from: tenantFrom(sub),
            subAccount: sub,
            meter: { subAccountId: saId },
          });
        }
      } catch (err) {
        console.warn("[booking/book] host notification send failed", err);
      }
    }
  }

  // Reminder schedule (no-op when payment is pending — gets scheduled
  // on mark-paid in Slice 8).
  if (page.remindersEnabled) {
    await scheduleEventReminders({
      eventId: created.eventDocRef.id,
      startAt: slotStart,
      reminderOffsetsMinutes: page.reminderOffsetsMinutes,
      rawToken: created.rawToken,
      pendingPayment: paymentRequired,
    });
  }

  // Auto-expire schedule for unpaid holds.
  if (paymentRequired && created.paymentHoldExpiresAt) {
    await schedulePaymentAutoExpire({
      eventId: created.eventDocRef.id,
      expiresAt: created.paymentHoldExpiresAt,
    });
  }

  if (!meetPushNow) pushBookingToGoogleAfterResponse(created.eventDocRef.id);

  // Activity + automation trigger.
  await recordBookingActivity(
    {
      id: created.eventDocRef.id,
      title: created.title,
      contactId: created.contactId,
      bookingPageSlug: page.slug,
      subAccountId: saId,
    },
    "booking_page_booked",
  );
  await fireBookingTrigger(
    {
      id: created.eventDocRef.id,
      agencyId,
      subAccountId: saId,
      contactId: created.contactId,
      bookingPageSlug: page.slug,
    },
    "event_booked",
  );
  // A free booking is confirmed the moment it's created; a paid hold only
  // becomes confirmed once mark-paid fires this same trigger.
  if (!paymentRequired) {
    await fireBookingTrigger(
      {
        id: created.eventDocRef.id,
        agencyId,
        subAccountId: saId,
        contactId: created.contactId,
        bookingPageSlug: page.slug,
      },
      "event_confirmed",
    );
  }
  runAfterResponse(() => emitBookingWebhook({
    eventId: created.eventDocRef.id,
    agencyId,
    subAccountId: saId,
    type: "booking_page_booked",
  }));

  // Post-booking redirect — confirmed (free) bookings only. Paid holds
  // stay on the in-app confirmation so the PayPal CTA is always shown.
  // Append booking_id + email so the destination page can de-dupe
  // conversions + fire pixel Advanced Matching. A malformed stored URL
  // never breaks a successful booking — it just falls back to no redirect.
  let redirectUrl: string | null = null;
  if (
    !paymentRequired &&
    page.redirectUrl &&
    isSafeFormRedirectUrl(page.redirectUrl)
  ) {
    try {
      const u = new URL(page.redirectUrl);
      // Append tracking params unless the operator opted out (legacy docs
      // with the field absent default to appending).
      if (page.redirectAppendParams !== false) {
        u.searchParams.set("booking_id", created.eventDocRef.id);
        u.searchParams.set("email", email);
      }
      redirectUrl = u.toString();
    } catch (err) {
      console.warn("[booking/book] invalid redirectUrl, skipping", err);
    }
  }

  return NextResponse.json({
    ok: true,
    eventId: created.eventDocRef.id,
    status: paymentRequired ? "awaiting_payment" : "scheduled",
    paymentUrl: created.paymentLinkUrl ?? null,
    publicEventUrl,
    confirmationMessage: page.confirmationMessage || null,
    redirectUrl,
  });
}

class SlotConflict extends Error {}

function labelForField(page: BookingPage, id: string): string {
  return page.intakeFields.find((f) => f.id === id)?.label ?? id;
}

// ── ICS attachment helper ──────────────────────────────────────────
// Goes through the shared sendEmail wrapper (which supports attachments)
// so the From/Reply-To policy can't be bypassed by the ICS path.

interface SendWithIcs {
  subAccount: SubAccountDoc;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  from?: string;
  icsAttachment?: { filename: string; content: string };
  /** Usage Metering v1 — workspace whose emailsSent ledger to increment. */
  meterSubAccountId?: string;
}

function buildIcsAttachment(params: {
  eventId: string;
  startAt: Date;
  endAt: Date;
  domain: string;
  title: string;
  description: string;
  location: string;
  organizerEmail?: string;
  organizerName?: string;
  attendeeEmail: string;
  attendeeName: string;
}): { filename: string; content: string } {
  const ics = generateIcs({
    uid: params.eventId,
    domain: params.domain,
    startAt: params.startAt,
    endAt: params.endAt,
    summary: params.title,
    description: params.description,
    location: params.location,
    organizerEmail: params.organizerEmail,
    organizerName: params.organizerName,
    attendeeEmail: params.attendeeEmail,
    attendeeName: params.attendeeName,
    method: "REQUEST",
    status: "CONFIRMED",
    sequence: 0,
  });
  // Base64-encode for the Resend attachments[].content field.
  const content = Buffer.from(ics, "utf-8").toString("base64");
  return { filename: "invite.ics", content };
}

async function sendEmailWithIcs(input: SendWithIcs): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    replyTo: input.replyTo,
    from: input.from,
    subAccount: input.subAccount,
    meter: input.meterSubAccountId
      ? { subAccountId: input.meterSubAccountId }
      : null,
    ...(input.icsAttachment
      ? {
          attachments: [
            {
              filename: input.icsAttachment.filename,
              content: input.icsAttachment.content,
            },
          ],
        }
      : {}),
  });
}
