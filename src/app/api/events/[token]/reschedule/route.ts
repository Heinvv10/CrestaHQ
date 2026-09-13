import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  computeAvailability,
  isSlotAvailable,
  type BusyEvent,
  type SlotCandidate,
} from "@/lib/booking/availability";
import {
  buildEventPublicUrl,
  hashEventToken,
  issueEventToken,
  verifyEventToken,
} from "@/lib/booking/event-token";
import { runRescheduleSideEffects } from "@/lib/booking/reschedule";
import { eventStatus } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";

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
 * operator route and v1 API reuse `runRescheduleSideEffects` from
 * lib/booking/reschedule.ts for identical post-write bookkeeping, but
 * skip this availability check (see rescheduleWithoutAvailabilityCheck).
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

  let body: RescheduleBody;
  try {
    body = (await request.json()) as RescheduleBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
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

  let outcome: Outcome | null = null;
  try {
    outcome = await db.runTransaction(async (txn) => {
      const eventSnap = await txn.get(eventRef);
      if (!eventSnap.exists) throw new TokenInvalid();
      const event = eventSnap.data() as CalendarEvent;
      if (event.publicTokenHash !== hashEventToken(token)) {
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

      // Busy events for the new slot's window — re-uses the same
      // pattern as the book route.
      const lookbackMs = 8 * 60 * 60_000;
      const queryFrom = new Date(newStart.getTime() - lookbackMs);
      const queryTo = new Date(newEnd.getTime() + 1000);
      const busySnap = await txn.get(
        db
          .collection("events")
          .where("subAccountId", "==", event.subAccountId)
          .where("startAt", ">=", queryFrom)
          .where("startAt", "<=", queryTo),
      );
      const busy: BusyEvent[] = [];
      for (const d of busySnap.docs) {
        if (d.id === eventRef.id) continue; // exclude our own slot
        const e = d.data() as CalendarEvent;
        const s = e.status ?? "scheduled";
        if (s !== "scheduled" && s !== "awaiting_payment") continue;
        const s2 = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
        const e2 = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
        if (!(s2 instanceof Date) || !(e2 instanceof Date)) continue;
        busy.push({ startAt: s2, endAt: e2 });
      }
      const free = computeAvailability({
        page,
        now: new Date(),
        fromInstant: new Date(newStart.getTime() - 1),
        toInstant: new Date(newEnd.getTime() + 1),
        busy,
      });
      const candidate: SlotCandidate = { startAt: newStart, endAt: newEnd };
      if (!isSlotAvailable(candidate, free)) {
        throw new SlotConflict();
      }

      const { token: newRawToken, hash: newHash } = issueEventToken(
        eventRef.id,
      );
      txn.update(eventRef, {
        startAt: newStart,
        endAt: newEnd,
        publicTokenHash: newHash,
        rescheduledAt: FieldValue.serverTimestamp(),
        rescheduleCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        newToken: newRawToken,
        pageSnap: pageSnap,
        event: { ...event, publicTokenHash: newHash } as CalendarEvent,
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
