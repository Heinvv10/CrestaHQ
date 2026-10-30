import "server-only";
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isSlotAvailable, type SlotCandidate } from "@/lib/booking/availability";
import { pageCalendarType } from "@/lib/booking/calendar-types";
import { assignBookingHosts, selectableHostUid } from "@/lib/booking/page-slots";
import { resolvePageAvailability } from "@/lib/booking/resolve-availability";
import { loadGoogleBusyForPage } from "@/lib/google-calendar/busy";
import { pushBookingToGoogleAfterResponse } from "@/lib/google-calendar/push";
import { loadHostUpcomingCounts } from "@/lib/booking/hosts";
import { effectiveBookingLocation, eventLocationText, oneLineText } from "@/lib/booking/location";
import { issueEventToken } from "@/lib/booking/event-token";
import { emitBookingWebhook, fireBookingTrigger, recordBookingActivity } from "@/lib/booking/lifecycle";
import { normalizePhoneLenient } from "@/lib/contacts/phone";
import { emitContactCreatedById } from "@/lib/server/contacts-service";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types/tenancy";
import { runAfterResponse } from "@/lib/server/after-response";
import { isDocId } from "@/lib/server/doc-id";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { getAgentBookingContext, unbookableReason } from "./agent-booking-queries";
import { CHANNEL_COPY, type AgentBookInput, type AgentBookResult } from "./agent-booking-types";
import { notifyAgentBookingHosts, sendConversationBookingFollowUps } from "./agent-booking-follow-ups";
export * from "./agent-booking-queries";
export type { AgentBookInput, AgentBookResult, AgentBookingChannel } from "./agent-booking-types";

class SlotConflict extends Error {}

/** Our public-page resolver and host assignment, shared by every conversational channel. */
export async function bookAgentSlot(input: AgentBookInput): Promise<AgentBookResult> {
  const { subAccountId, agencyId, channel } = input;
  if (!Object.hasOwn(CHANNEL_COPY, channel) || !isDocId(subAccountId) || !isDocId(agencyId) ||
      !isDocId(input.page.slug) || (input.contactId != null && !isDocId(input.contactId)) ||
      (input.callId != null && !isDocId(input.callId))) return { ok: false, code: "error" };
  const ctx = await getAgentBookingContext(subAccountId, input.page.slug);
  if (!ctx?.bookable || ctx.page.agencyId !== agencyId) return { ok: false, code: "error" };
  const page = ctx.page;
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists || subSnap.data()?.agencyId !== agencyId) return { ok: false, code: "error" };
  const sub = subSnap.data() as SubAccountDoc;
  const copy = CHANNEL_COPY[channel];
  const isPhone = channel === "phone";
  const db = getAdminDb();

  const slotStart = new Date(input.startAtIso);
  if (Number.isNaN(slotStart.getTime()) || slotStart.getTime() <= Date.now()) {
    return { ok: false, code: "invalid_slot" };
  }
  const slotEnd = new Date(
    slotStart.getTime() + page.durationMinutes * 60_000,
  );
  const callerName = oneLineText(input.name).slice(0, 120);
  const callerPhone = oneLineText(input.phone ?? "").slice(0, 40);
  const email = oneLineText(input.email ?? "").toLowerCase().slice(0, 200);
  const locationText = eventLocationText(effectiveBookingLocation(page), {
    phone: oneLineText(input.locationPhone ?? "").slice(0, 40) || callerPhone,
    address: oneLineText(input.address ?? "").slice(0, 300),
  });
  const notes = [copy.notes, locationText ? `Where: ${locationText}` : "",
    ...(input.intakeAnswers ?? []).slice(0, 20).map(a => `${oneLineText(a.label).slice(0, 120)}: ${oneLineText(a.value).slice(0, 1000)}`),
  ].filter(Boolean).join("\n");

  const territoryId =
    page.defaultTerritoryId && page.defaultTerritoryId.length > 0
      ? page.defaultTerritoryId
      : GLOBAL_TERRITORY_ID;

  let contactId = input.contactId;
  if (contactId) {
    const contact = await loadEventContact({ subAccountId, contactId });
    if (!contact) return { ok: false, code: "error" };
    const patch: Record<string, unknown> = {};
    if (callerName && !contact.name?.trim()) patch.name = callerName;
    if (!isPhone && email && !contact.email?.trim()) patch.email = email;
    if (!isPhone && callerPhone && !contact.phone?.trim()) patch.phone = normalizePhoneLenient(callerPhone, sub.defaultPhoneCountry ?? null);
    if (Object.keys(patch).length) await db.doc(`contacts/${contactId}`).update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  } else if (!isPhone) {
    return { ok: false, code: "error" };
  }
  const replayKey = contactId || input.callId;
  const eventDocRef = replayKey
    ? db.collection("events").doc(`ab_${createHash("sha256").update(JSON.stringify([subAccountId, page.slug, channel, replayKey, slotStart.toISOString()])).digest("hex")}`)
    : db.collection("events").doc();
  const newContactRef = !contactId ? db.collection("contacts").doc(`ab_${eventDocRef.id}`) : null;
  contactId ??= newContactRef!.id;
  if (isPhone && input.callId) await db.doc(`subAccounts/${subAccountId}/voiceCalls/${input.callId}`).set({
    voiceBooking: { attemptedAt: new Date().toISOString() },
  }, { merge: true });

  const now = new Date();

  const selectedHostUid = selectableHostUid(page, input.hostUid);
  const hosts = page.hosts ?? [];
  const loadByHost =
    hosts.length > 0 && pageCalendarType(page) === "round_robin"
      ? await loadHostUpcomingCounts(
          subAccountId,
          hosts.map((h) => h.uid),
          now,
        )
      : new Map<string, number>();
  const externalBusy = await loadGoogleBusyForPage({
    subAccountId,
    page,
    now,
    fromInstant: new Date(slotStart.getTime() - 1),
    toInstant: new Date(slotEnd.getTime() + 1),
  });

  let created: {
    replay?: boolean;
    rawToken: string;
    title: string;
    assignedToUid: string | null;
    assignedToName: string | null;
    hostUids: string[] | null;
  };
  try {
    created = await db.runTransaction(async (txn) => {
      const existing = await txn.get(eventDocRef);
      if (existing.exists) {
        const e = existing.data()!;
        if (e.subAccountId !== subAccountId || e.contactId !== contactId || e.status !== "scheduled" ||
            dateMillis(e.startAt) !== slotStart.getTime() || dateMillis(e.endAt) !== slotEnd.getTime()) throw new SlotConflict();
        return { replay: true, rawToken: "", title: e.title as string,
          assignedToUid: e.assignedToUid as string | null, assignedToName: e.assignedToName as string | null,
          hostUids: (e.hostUids ?? null) as string[] | null };
      }
      const fresh = await txn.get(db.doc(`subAccounts/${subAccountId}/bookingPages/${page.slug}`));
      const current = fresh.data() as BookingPage | undefined;
      if (!current || current.subAccountId !== subAccountId || current.agencyId !== agencyId ||
          current.slug !== page.slug || unbookableReason(current) || JSON.stringify(current) !== JSON.stringify(page)) throw new SlotConflict();
      if (!newContactRef) {
        const contact = await txn.get(db.doc(`contacts/${contactId}`));
        if (!contact.exists || contact.data()?.subAccountId !== subAccountId) throw new SlotConflict();
      }
      const free = await resolvePageAvailability({
        subAccountId,
        page: current,
        now,
        fromInstant: new Date(slotStart.getTime() - 1),
        toInstant: new Date(slotEnd.getTime() + 1),
        onlyHostUid: selectedHostUid,
        ignoreMinNotice: true,
        externalBusy,
        txn,
      });
      const candidate: SlotCandidate = { startAt: slotStart, endAt: slotEnd };
      const slotMatch = free.find((s) => isSlotAvailable(candidate, [s]));
      const assignment = slotMatch
        ? assignBookingHosts(current, slotMatch, loadByHost)
        : null;
      if (!assignment) throw new SlotConflict();
      const { assignedToUid, assignedToName } = assignment;

      const title = `${page.name} — ${callerName || callerPhone || copy.fallbackName}`;
      const { token, hash } = issueEventToken(eventDocRef.id);

      if (newContactRef) txn.create(newContactRef, {
        name: callerName, email: "", phone: callerPhone, company: "", address: "", source: "voice",
        tags: [], pipelineStage: null, attribution: null, agencyId, subAccountId,
        createdByUid: copy.createdByUid, emailOptedOut: false, smsOptedOut: false,
        countryCode: null, country: null, city: null, lat: null, lng: null, territoryId,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      txn.create(eventDocRef, {
        id: eventDocRef.id,
        title,
        startAt: slotStart,
        endAt: slotEnd,
        contactId,
        location: locationText,
        meetingUrl: page.meetingUrl ?? null,
        notes,
        agencyId,
        subAccountId,
        createdByUid: copy.createdByUid,
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
        ...(assignment.hostUids ? { hostUids: assignment.hostUids } : {}),
        cancelledAt: null,
        cancelledByVisitor: null,
        cancelReason: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { rawToken: token, title, assignedToUid, assignedToName, hostUids: assignment.hostUids };
    });
  } catch (err) {
    if (err instanceof SlotConflict) return { ok: false, code: "slot_taken" };
    console.error(
      `[agent-booking] transaction failed sa=${subAccountId} slug=${page.slug}`,
      "transaction_failed",
    );
    return { ok: false, code: "error" };
  }

  if (created.replay) return { ok: true, eventId: eventDocRef.id, startAt: slotStart, endAt: slotEnd, assignedToName: created.assignedToName };
  if (newContactRef) runAfterResponse(() => emitContactCreatedById({ subAccountId, agencyId, contactId: newContactRef.id }));
  if (isPhone) pushBookingToGoogleAfterResponse(eventDocRef.id);

  try {
    await recordBookingActivity(
      {
        id: eventDocRef.id,
        title: created.title,
        contactId: contactId!,
        bookingPageSlug: page.slug,
        subAccountId,
      },
      "booking_page_booked",
    );
    await fireBookingTrigger(
      {
        id: eventDocRef.id,
        agencyId,
        subAccountId,
        contactId: contactId!,
        bookingPageSlug: page.slug,
      },
      "event_booked",
    );
    await fireBookingTrigger(
      {
        id: eventDocRef.id,
        agencyId,
        subAccountId,
        contactId: contactId!,
        bookingPageSlug: page.slug,
      },
      "event_confirmed",
    );
    runAfterResponse(() => emitBookingWebhook({
      eventId: eventDocRef.id,
      agencyId,
      subAccountId,
      type: "booking_page_booked",
    }));
  } catch (err) {
    console.warn("[agent-booking] side effects failed", err instanceof Error ? err.name : "unknown");
  }


  const followUp = { subAccountId, page, eventId: eventDocRef.id, contactId, created,
    rawToken: created.rawToken, slotStart, slotEnd, name: callerName, email, phone: callerPhone,
    notes, locationText, fallbackName: copy.fallbackName };
  if (isPhone) await notifyAgentBookingHosts({ ...followUp, customerName: callerName || callerPhone || copy.fallbackName,
    customerEmail: email, customerPhone: callerPhone, manageUrl: null });
  else runAfterResponse(() => sendConversationBookingFollowUps(followUp));

  if (isPhone && input.callId) {
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
      console.warn("[agent-booking] booking stamp failed", err instanceof Error ? err.name : "unknown");
    }
  }

  return { ok: true, eventId: eventDocRef.id, startAt: slotStart, endAt: slotEnd, assignedToName: created.assignedToName };
}


function dateMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return (value as { toMillis?: () => number } | null)?.toMillis?.() ?? NaN;
}
