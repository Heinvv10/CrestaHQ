import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  isSlotAvailable,
  type SlotCandidate,
} from "@/lib/booking/availability";
import {
  departedHostMessage,
  movingEventOf,
  resolvePageAvailability,
} from "@/lib/booking/resolve-availability";
import {
  buildEventPublicUrl,
  hashEventToken,
  issueEventToken,
  verifyEventToken,
} from "@/lib/booking/event-token";
import { runRescheduleSideEffects } from "@/lib/booking/reschedule";
import { nextIcsSequence } from "@/lib/booking/ics";
import { loadGoogleBusyForEvent } from "@/lib/google-calendar/busy";
import { eventStatus, isImportedEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import { readJsonCapped } from "@/lib/server/read-json-capped";

/**
 * Public reschedule endpoint. The HMAC token IS the credential. On
 * success: rotates the token (any previously-mailed link invalidates),
 * updates `startAt` + `endAt` in-place (preserves event id, automations,
 * activity history), re-publishes reminder callbacks for the new
 * schedule, and sends a fresh confirmation email + ICS.
 *
 * Important constraints:
 *   - Status must currently occupy a slot (scheduled / awaiting_payment).
 *     Cancelled / past meetings can't be rescheduled — visitor must
 *     re-book.
 *   - Payment-pending events keep the payment requirement on the new
 *     slot (operator still has to mark paid). The hold-expiry deadline
 *     is NOT extended — visitor should pay quickly regardless.
 *
 * The only path here that checks slot availability — it's the only actor
 * without a human on the other end double-checking the calendar. The
 * operator route reuses `runRescheduleSideEffects` from
 * lib/booking/reschedule.ts for identical post-write bookkeeping, but
 * skips this availability check (see rescheduleWithoutAvailabilityCheck).
 */

interface RescheduleBody {
  slot?: { startAt?: string; endAt?: string };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

  const verified = verifyEventToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  // The new slot (two timestamps): 16 KB.
  const read = await readJsonCapped(request, 16 * 1024);
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json({ error: "Request body too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = (read.value ?? {}) as RescheduleBody;
  const newStart = body.slot?.startAt ? new Date(body.slot.startAt) : null;
  const newEnd = body.slot?.endAt ? new Date(body.slot.endAt) : null;
  if (
    !newStart ||
    !newEnd ||
    Number.isNaN(newStart.getTime()) ||
    Number.isNaN(newEnd.getTime()) ||
    newEnd <= newStart
  ) {
    return NextResponse.json(
      { error: "Pick a valid new time." },
      { status: 400 },
    );
  }
  if (newStart.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Choose a time in the future." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const eventRef = db.collection("events").doc(verified.eventId);

  type Outcome = {
    newToken: string;
    pageSnap: FirebaseFirestore.DocumentSnapshot | null;
    event: CalendarEvent;
    rotatedHash: string;
    newStart: Date;
    newEnd: Date;
  };

  // The page hosts' Google busy (SP3 G2), loaded BEFORE the transaction.
  const externalBusy = await loadGoogleBusyForEvent(
    verified.eventId,
    new Date(newStart.getTime() - 1),
    new Date(newEnd.getTime() + 1),
  );

  let outcome: Outcome | null = null;
  try {
    outcome = await db.runTransaction(async (txn) => {
      const eventSnap = await txn.get(eventRef);
      if (!eventSnap.exists) throw new TokenInvalid();
      const event = eventSnap.data() as CalendarEvent;
      if (event.publicTokenHash !== hashEventToken(token) || isImportedEvent(event)) {
        throw new TokenInvalid();
      }
      const status = eventStatus(event);
      if (status !== "scheduled" && status !== "awaiting_payment") {
        throw new BadState(
          status === "cancelled"
            ? "This booking was cancelled. Please re-book."
            : "This meeting can't be rescheduled.",
        );
      }
      if (!event.bookingPageSlug) {
        throw new BadState("Reschedule isn't available for this booking.");
      }

      // Load the booking page inside the txn so its config is the same
      // one used to verify availability.
      const pageRef = db.doc(
        `subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`,
      );
      const pageSnap = await txn.get(pageRef);
      if (!pageSnap.exists) {
        throw new BadState(
          "The booking page is no longer available. Please cancel and re-book later.",
        );
      }
      const page = pageSnap.data() as BookingPage;
      const departed = await departedHostMessage(page, event);
      if (departed) throw new BadState(departed);

      // Re-verify through the same resolver the booking used, as a moved
      // booking: its own host(s) and service, its current slot not busy. A
      // team booking is checked against its host's calendar only — not
      // every host's (and a collective one against all of its hosts); a
      // hostless one against every event, as it was booked.
      const free = await resolvePageAvailability({
        subAccountId: event.subAccountId,
        page,
        now: new Date(),
        fromInstant: new Date(newStart.getTime() - 1),
        toInstant: new Date(newEnd.getTime() + 1),
        movingEvent: movingEventOf(eventRef.id, event),
        serviceId: event.serviceId ?? null,
        externalBusy,
        txn,
      });
      const candidate: SlotCandidate = { startAt: newStart, endAt: newEnd };
      if (!isSlotAvailable(candidate, free)) {
        throw new SlotConflict();
      }

      const { token: newRawToken, hash: newHash } = issueEventToken(
        eventRef.id,
      );
      const icsSequence = nextIcsSequence(event);
      txn.update(eventRef, {
        startAt: newStart,
        endAt: newEnd,
        publicTokenHash: newHash,
        icsSequence,
        rescheduledAt: FieldValue.serverTimestamp(),
        rescheduleCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        newToken: newRawToken,
        pageSnap: pageSnap,
        event: { ...event, publicTokenHash: newHash, icsSequence } as CalendarEvent,
        rotatedHash: newHash,
        newStart,
        newEnd,
      };
    });
  } catch (err) {
    if (err instanceof TokenInvalid) {
      return NextResponse.json({ error: "Invalid link" }, { status: 404 });
    }
    if (err instanceof BadState) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SlotConflict) {
      return NextResponse.json(
        {
          error:
            "That time was just taken. Refresh and pick another option.",
        },
        { status: 409 },
      );
    }
    console.error("[events/reschedule] txn failed", err);
    return NextResponse.json(
      { error: "Couldn't reschedule. Try again." },
      { status: 500 },
    );
  }

  if (!outcome) {
    return NextResponse.json({ ok: true }); // unreachable; appease ts
  }
  const { newToken, event, pageSnap, newStart: nsa, newEnd: nea } = outcome;
  const page = pageSnap?.data() as BookingPage | undefined;
  const publicEventUrl = buildEventPublicUrl(newToken);

  // Side effects: reminder reschedule + activity + trigger + emails.
  await runRescheduleSideEffects({
    event,
    page,
    newRawToken: newToken,
    publicEventUrl,
    startAt: nsa,
    endAt: nea,
    actor: "visitor",
  });

  return NextResponse.json({
    ok: true,
    newStartAt: nsa.toISOString(),
    newEndAt: nea.toISOString(),
    newToken,
    publicEventUrl,
  });
}

class TokenInvalid extends Error {}
class BadState extends Error {
  constructor(public readonly message: string) {
    super(message);
  }
}
class SlotConflict extends Error {}
