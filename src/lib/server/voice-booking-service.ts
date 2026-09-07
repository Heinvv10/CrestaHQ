import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  computeAvailability,
  computeUnionAvailability,
  groupSlotsByLocalDate,
  isSlotAvailable,
  type BusyEvent,
  type BusyEventWithHost,
  type SlotCandidate,
} from "@/lib/booking/availability";
import {
  loadHostNotifyContact,
  loadHostUpcomingCounts,
  pickLeastLoadedHost,
} from "@/lib/booking/hosts";
import { issueEventToken } from "@/lib/booking/event-token";
import {
  emitBookingWebhook,
  fireBookingTrigger,
  recordBookingActivity,
} from "@/lib/booking/lifecycle";
import { renderBookingHostNotificationEmail } from "@/lib/booking/email";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { emitContactCreatedById } from "@/lib/server/contacts-service";
import { eventOccupiesSlot, eventStatus } from "@/types/events";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import type { CalendarEvent } from "@/types/events";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * Voice Booking v1 — the AI voice agent booking real appointments during a
 * call (see VOICE_BOOKING_V1_PLAN.md). This service is the server-side
 * half: slot listing + the transactional book, called from the Vapi LLM
 * webhook's marker loop (`/api/webhooks/vapi/llm/[subAccountId]`).
 *
 * It deliberately reuses the SAME pure building blocks as the public
 * booking route (`computeAvailability` / `computeUnionAvailability` /
 * `isSlotAvailable`, host assignment, `issueEventToken`, the lifecycle
 * helpers) so a voice booking can't disagree with what the public page
 * shows or produce a different event shape. Locked-scope differences from
 * the public route:
 *   - PHONE-ONLY (pick 1): a page's email requirement is waived — the
 *     caller is identified by caller-ID phone; no confirmation email and
 *     no reminder schedule in v1 (both are email-based).
 *   - 7-DAY horizon (pick 2), capped at the page's own visibleDays.
 *   - Paid/deposit pages are refused upstream (the context loader below
 *     returns bookable: false) — the deposit flow doesn't fit a call.
 *   - Intake fields are waived like email — a phone call can't fill a
 *     form; the event notes record that it was booked by the voice agent.
 */

const VOICE_HORIZON_DAYS = 7;
/** Slots handed to the LLM per [[slots]] request are capped by DAY COUNT,
 *  not a flat total: a single busy business day easily has 6+ open slots,
 *  and a flat cap would let that one day crowd out every later day so the
 *  model never sees (or can offer) them. Represent up to this many distinct
 *  days, with a generous per-day allowance so the model can still find a
 *  time later in a given day. The model still offers ≤3 verbally. */
const MAX_DAYS_FOR_LLM = 3;
const MAX_SLOTS_PER_DAY_FOR_LLM = 8;
const BUSY_LOOKBACK_MS = 8 * 60 * 60_000;

export interface VoiceBookingContext {
  page: BookingPage;
  bookable: boolean;
  /** Why not bookable (logged, never spoken verbatim). */
  reason: string | null;
}

/**
 * Load the voice channel's designated booking page. Returns null when the
 * slug doesn't resolve; `bookable: false` for pages voice can't book
 * (unpublished, deposit-taking) so the caller can silently fall back to
 * today's link-by-text behavior.
 */
export async function getVoiceBookingContext(
  subAccountId: string,
  slug: string,
): Promise<VoiceBookingContext | null> {
  const snap = await getAdminDb()
    .doc(`subAccounts/${subAccountId}/bookingPages/${slug}`)
    .get();
  if (!snap.exists) return null;
  const page = snap.data() as BookingPage;
  if (page.status !== "published") {
    return { page, bookable: false, reason: "page_not_published" };
  }
  if (page.payment) {
    return { page, bookable: false, reason: "page_requires_payment" };
  }
  return { page, bookable: true, reason: null };
}

/**
 * Next available slots within the voice horizon (7 days, capped by the
 * page's visibleDays). Same busy-event fetch + pure computation as the
 * public availability endpoint, truncated for a spoken offer.
 */
export async function listVoiceSlots(
  subAccountId: string,
  page: BookingPage,
  /** Narrow to one host (named selection). Honoured only on pages with
   *  `allowHostSelection` on; ignored otherwise. */
  hostUid?: string | null,
): Promise<SlotCandidate[]> {
  const db = getAdminDb();
  const now = new Date();
  const horizonDays = Math.min(VOICE_HORIZON_DAYS, page.visibleDays || VOICE_HORIZON_DAYS);
  const toInstant = new Date(now.getTime() + horizonDays * 24 * 60 * 60_000);
  const queryFrom = new Date(now.getTime() - BUSY_LOOKBACK_MS);

  const busy: BusyEventWithHost[] = [];
  const eventsSnap = await db
    .collection("events")
    .where("subAccountId", "==", subAccountId)
    .where("startAt", ">=", queryFrom)
    .where("startAt", "<=", toInstant)
    .get();
  for (const d of eventsSnap.docs) {
    const e = d.data() as CalendarEvent;
    if (!eventOccupiesSlot(eventStatus(e))) continue;
    const startAt = (e.startAt as { toDate?: () => Date } | null)?.toDate?.();
    const endAt = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
    if (!(startAt instanceof Date) || !(endAt instanceof Date)) continue;
    busy.push({ startAt, endAt, assignedToUid: e.assignedToUid ?? null });
  }

  const hosts = page.hosts ?? [];
  // Narrowing is only valid on opted-in pages and for a real host uid.
  const onlyHostUid =
    page.allowHostSelection === true &&
    hostUid &&
    hosts.some((h) => h.uid === hostUid)
      ? hostUid
      : null;
  const slots =
    hosts.length > 0
      ? computeUnionAvailability({
          page,
          now,
          toInstant,
          busy,
          hostUids: hosts.map((h) => h.uid),
          onlyHostUid,
        })
      : computeAvailability({
          page,
          now,
          toInstant,
          busy: busy.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
        });
  // Cap by day (not a flat total) so multiple days are always represented.
  const byDay = groupSlotsByLocalDate(slots, page.timezone);
  const out: SlotCandidate[] = [];
  for (const day of byDay.slice(0, MAX_DAYS_FOR_LLM)) {
    out.push(...day.slots.slice(0, MAX_SLOTS_PER_DAY_FOR_LLM));
  }
  return out;
}

class SlotConflict extends Error {}

export type VoiceBookResult =
  | { ok: true; eventId: string; startAt: Date; endAt: Date }
  | { ok: false; code: "slot_taken" | "invalid_slot" | "error" };

/**
 * Book one slot for a caller. Mirrors the public book route's
 * transactional re-verify (single + team modes, least-loaded host
 * assignment) and event-doc shape, with the locked voice differences
 * (phone-only, no payment, no email/reminders). The contact is resolved
 * OUTSIDE the transaction: the LLM route's caller-ID contact when known,
 * else a fresh phone-first contact (`source: "voice"`, same as voice
 * captures) whose creation fires contact.created like every other path.
 */
export async function bookVoiceSlot(input: {
  subAccountId: string;
  agencyId: string;
  page: BookingPage;
  startAtIso: string;
  callerName: string;
  callerPhone: string;
  /** Optional email the caller volunteered mid-call — used only for the
   *  internal host-notification email (voice sends no CUSTOMER email). */
  callerEmail?: string | null;
  /** Contact already matched by caller ID in the LLM route, if any. */
  contactId: string | null;
  /** Requested host (named selection), already resolved from a spoken name to
   *  a uid by the LLM route. Honoured only on `allowHostSelection` pages;
   *  ignored otherwise. Null ⇒ pooled least-loaded assignment. */
  hostUid?: string | null;
  /** Vapi call id — when present, a successful booking is stamped onto the
   *  `voiceCalls/{callId}` doc so the end-of-call handler creates a
   *  follow-up Task (voice bookings send no confirmation email). */
  callId?: string | null;
}): Promise<VoiceBookResult> {
  const { subAccountId, agencyId, page } = input;
  const db = getAdminDb();

  const slotStart = new Date(input.startAtIso);
  if (Number.isNaN(slotStart.getTime()) || slotStart.getTime() <= Date.now()) {
    return { ok: false, code: "invalid_slot" };
  }
  const slotEnd = new Date(
    slotStart.getTime() + page.durationMinutes * 60_000,
  );
  const callerName = input.callerName.trim().slice(0, 120);
  const callerPhone = input.callerPhone.trim().slice(0, 40);

  const territoryId =
    page.defaultTerritoryId && page.defaultTerritoryId.length > 0
      ? page.defaultTerritoryId
      : GLOBAL_TERRITORY_ID;

  // ── Resolve the contact (phone-first; never the email path) ────────
  let contactId = input.contactId;
  let contactCreated = false;
  if (!contactId) {
    const ref = await db.collection("contacts").add({
      name: callerName,
      email: "",
      phone: callerPhone,
      company: "",
      address: "",
      source: "voice",
      tags: [],
      pipelineStage: null,
      attribution: null,
      agencyId,
      subAccountId,
      createdByUid: "voice-agent",
      emailOptedOut: false,
      smsOptedOut: false,
      countryCode: null,
      country: null,
      city: null,
      lat: null,
      lng: null,
      territoryId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    contactId = ref.id;
    contactCreated = true;
    void emitContactCreatedById({ subAccountId, agencyId, contactId: ref.id });
  } else if (callerName) {
    // Best-effort: fill a missing name on the existing contact.
    try {
      const snap = await db.collection("contacts").doc(contactId).get();
      if (snap.exists && !(snap.data()?.name as string | undefined)) {
        await snap.ref.update({
          name: callerName,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    } catch {
      // Non-fatal.
    }
  }

  // ── Transactional create with re-verify (mirrors the book route) ──
  const queryFrom = new Date(slotStart.getTime() - BUSY_LOOKBACK_MS);
  const queryTo = new Date(slotEnd.getTime() + 1000);
  const eventsRef = db.collection("events");
  const eventDocRef = eventsRef.doc();
  const now = new Date();

  const hosts = page.hosts ?? [];
  const teamMode = hosts.length > 0;
  // Named-host selection: honour a requested host only on opted-in pages and
  // only when it names a real host. Otherwise pooled least-loaded assignment.
  const selectedHostUid =
    page.allowHostSelection === true &&
    input.hostUid &&
    hosts.some((h) => h.uid === input.hostUid)
      ? input.hostUid
      : null;
  const loadByHost = teamMode
    ? await loadHostUpcomingCounts(
        subAccountId,
        hosts.map((h) => h.uid),
        now,
      )
    : new Map<string, number>();

  let created: {
    title: string;
    assignedToUid: string | null;
    assignedToName: string | null;
  };
  try {
    created = await db.runTransaction(async (txn) => {
      const busySnap = await txn.get(
        eventsRef
          .where("subAccountId", "==", subAccountId)
          .where("startAt", ">=", queryFrom)
          .where("startAt", "<=", queryTo),
      );
      const occupying: BusyEvent[] = [];
      const sharedBusy: BusyEvent[] = [];
      const occupyingByHost = new Map<string, BusyEvent[]>();
      for (const d of busySnap.docs) {
        const e = d.data() as CalendarEvent;
        if (!eventOccupiesSlot(eventStatus(e))) continue;
        const startVal = (
          e.startAt as { toDate?: () => Date } | null
        )?.toDate?.();
        const endVal = (e.endAt as { toDate?: () => Date } | null)?.toDate?.();
        if (!(startVal instanceof Date) || !(endVal instanceof Date)) continue;
        const be: BusyEvent = { startAt: startVal, endAt: endVal };
        occupying.push(be);
        const host = e.assignedToUid ?? null;
        if (host == null) {
          sharedBusy.push(be);
        } else {
          const arr = occupyingByHost.get(host) ?? [];
          arr.push(be);
          occupyingByHost.set(host, arr);
        }
      }

      const candidate: SlotCandidate = { startAt: slotStart, endAt: slotEnd };
      let assignedToUid: string | null = null;
      let assignedToName: string | null = null;

      if (teamMode) {
        // When the caller asked for a specific person, only that host is a
        // candidate — never silently reassign. A gone slot is a conflict.
        const candidateHosts = selectedHostUid
          ? hosts.filter((h) => h.uid === selectedHostUid)
          : hosts;
        const freeHosts = candidateHosts.filter((h) => {
          const hostBusy = occupyingByHost.get(h.uid) ?? [];
          const free = computeAvailability({
            page,
            now,
            fromInstant: new Date(slotStart.getTime() - 1),
            toInstant: new Date(slotEnd.getTime() + 1),
            busy: [...sharedBusy, ...hostBusy],
            // Each host against their OWN working hours (override when set) so
            // a host with custom hours is only booked inside their window.
            workingHoursOverride:
              h.workingHours && h.workingHours.length > 0
                ? h.workingHours
                : undefined,
            // Re-verify of an already-offered slot: only guard against real
            // conflicts, not the moving min-notice window (see the flag's
            // doc). Prevents the false "slot just got taken" on live calls.
            ignoreMinNotice: true,
          });
          return isSlotAvailable(candidate, free);
        });
        const chosen = pickLeastLoadedHost(freeHosts, loadByHost);
        if (!chosen) throw new SlotConflict();
        assignedToUid = chosen.uid;
        assignedToName = chosen.name;
      } else {
        const free = computeAvailability({
          page,
          now,
          fromInstant: new Date(slotStart.getTime() - 1),
          toInstant: new Date(slotEnd.getTime() + 1),
          busy: occupying,
          // Re-verify of an already-offered slot: real conflicts only, not
          // the moving min-notice window (see the flag's doc).
          ignoreMinNotice: true,
        });
        if (!isSlotAvailable(candidate, free)) throw new SlotConflict();
      }

      const title = `${page.name} — ${callerName || callerPhone || "Phone booking"}`;
      const { hash } = issueEventToken(eventDocRef.id);

      txn.set(eventDocRef, {
        id: eventDocRef.id,
        title,
        startAt: slotStart,
        endAt: slotEnd,
        contactId,
        location: "",
        meetingUrl: page.meetingUrl ?? null,
        notes: "Booked by phone via the AI voice agent.",
        agencyId,
        subAccountId,
        createdByUid: "voice-agent",
        territoryId,
        status: "scheduled",
        source: "booking_page",
        bookingPageSlug: page.slug,
        publicTokenHash: hash,
        paymentRequired: false,
        paymentAmount: null,
        paymentCurrency: null,
        paymentLinkUrl: null,
        paidAt: null,
        paidByUid: null,
        paymentHoldExpiresAt: null,
        assignedToUid,
        assignedToName,
        cancelledAt: null,
        cancelledByVisitor: null,
        cancelReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { title, assignedToUid, assignedToName };
    });
  } catch (err) {
    if (err instanceof SlotConflict) return { ok: false, code: "slot_taken" };
    console.error(
      `[voice-booking] transaction failed sa=${subAccountId} slug=${page.slug}`,
      err,
    );
    return { ok: false, code: "error" };
  }

  // ── Post-write side effects (best-effort, same set as the route minus
  //    the email + reminder schedule — both email-based, waived in v1) ──
  try {
    await recordBookingActivity(
      {
        id: eventDocRef.id,
        title: created.title,
        contactId: contactId!,
        bookingPageSlug: page.slug,
      },
      "booking_page_booked",
    );
    await fireBookingTrigger(
      { agencyId, subAccountId, contactId: contactId! },
      "event_booked",
    );
    void emitBookingWebhook({
      eventId: eventDocRef.id,
      agencyId,
      subAccountId,
      type: "booking_page_booked",
    });
  } catch (err) {
    console.warn("[voice-booking] side effects failed", err);
  }
  void contactCreated;

  // Notify the assigned host — voice sends NO customer email, but the host
  // still needs to know (a v1 gap: Voice Booking never notified the host).
  // Best-effort; never affects the caller's booking. Team mode only.
  if (created.assignedToUid && created.assignedToName) {
    try {
      const [hostContact, subSnap] = await Promise.all([
        loadHostNotifyContact(subAccountId, created.assignedToUid),
        db.doc(`subAccounts/${subAccountId}`).get(),
      ]);
      const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
      if (hostContact && sub && emailIsConfigured(sub)) {
        const rendered = renderBookingHostNotificationEmail({
          hostName: hostContact.name,
          businessName: sub.name ?? "Booking",
          businessLogoUrl: sub.logoUrl,
          page: {
            name: page.name,
            durationMinutes: page.durationMinutes,
            timezone: page.timezone,
          },
          startAt: slotStart,
          endAt: slotEnd,
          customerName: callerName || callerPhone || "Phone booking",
          customerEmail: (input.callerEmail ?? "").trim(),
          customerPhone: callerPhone,
          notes: "Booked by phone via the AI voice agent.",
          manageUrl: null,
        });
        await sendEmail({
          to: hostContact.email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          from: tenantFrom(sub),
          subAccount: sub,
          meter: { subAccountId },
        });
      }
    } catch (err) {
      console.warn("[voice-booking] host notification send failed", err);
    }
  }

  // Correlate the successful booking onto the voiceCalls doc (keyed by Vapi
  // call id) so the end-of-call handler creates a follow-up Task — a caller
  // busy booking never triggers `callbackRequested`, and a phone-only voice
  // booking sends NO confirmation email, so the team needs a nudge to
  // confirm. Best-effort merge; the doc is fully written at end-of-call.
  if (input.callId) {
    try {
      await db
        .doc(`subAccounts/${subAccountId}/voiceCalls/${input.callId}`)
        .set(
          {
            voiceBooking: {
              booked: {
                eventId: eventDocRef.id,
                startAtIso: slotStart.toISOString(),
              },
            },
          },
          { merge: true },
        );
    } catch (err) {
      console.warn("[voice-booking] booking stamp failed", err);
    }
  }

  return { ok: true, eventId: eventDocRef.id, startAt: slotStart, endAt: slotEnd };
}

/** Spoken-friendly label for a slot in the page's timezone, e.g.
 *  "Tuesday, July 28 at 10:00 AM". Fed to the LLM, never TTS-critical. */
export function formatSlotForSpeech(startAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(startAt);
  } catch {
    return startAt.toISOString();
  }
}
