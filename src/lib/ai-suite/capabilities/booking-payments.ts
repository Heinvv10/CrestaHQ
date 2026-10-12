import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured } from "@/lib/comms/resend";
import { loadEventContact } from "@/lib/server/tenant-ref";
import { markBookingPaidServerSide } from "@/lib/server/bookings-service";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { collectVisible, territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { eventStatus, type CalendarEvent } from "@/types/events";
import type { BookingPage } from "@/types/booking";
import type { SubAccountDoc } from "@/types/tenancy";
import { CapabilityUserError, type AiSuiteCapability, type PreviewRow } from "./types";
import { contactNamesById, fmtInTz, fmtMoney, str, subAccountTimezone, toDate } from "./helpers";
import { oneLine } from "./text-safety";
import { masked } from "./conversation-send-support";
import { recordProvenanceRows } from "./record-provenance";
import { activeWorkflowsOn } from "./workflow-support";
import { tenantEvent } from "./event-status";

/**
 * Bookings held for a deposit (UPSTREAM_PORT_PLAN.md, N2a).
 * find_awaiting_payment_bookings is a read for chat and API agents.
 * mark_booking_paid confirms the booking the way the calendar's Mark paid
 * button does (markBookingPaidServerSide), which emails the customer their
 * confirmation and starts the booking.confirmed workflows — so it is never a
 * chat action, and on the agent surface a person approves it (outbound):
 * the preview shows and pins the recipient, the reminders and the workflows,
 * and the service sends only to the pinned recipient and starts only the
 * pinned workflows.
 */

/** Bookings listed, soonest first; held bookings read at most. */
const SHOWN = 20;
const MAX_SCAN = 1000;

/** Chat has no approval queue: the person marks it paid on the calendar. */
const CHAT_REFUSAL =
  "Marking a booking paid emails the customer their confirmation, so I can't do it from here. Open the booking on the Calendar and click Mark paid.";

/** The booking.confirmed workflows marking it paid starts, matched as the engine matches them. */
async function paidWorkflows(event: CalendarEvent) {
  if (!event.contactId) return [];
  return (await activeWorkflowsOn(event.subAccountId, "booking.confirmed")).filter((w) => {
    const slug = (w.trigger as { bookingPageSlug?: string | null } | undefined)?.bookingPageSlug;
    return !slug || slug === (event.bookingPageSlug ?? null);
  });
}

/** What confirming it would send and start (as runMarkPaidSideEffects decides), and how the approver reads it. */
async function paidPlan(event: CalendarEvent) {
  const db = getAdminDb();
  const [contact, subSnap, pageSnap, workflows] = await Promise.all([
    loadEventContact(event),
    db.doc(`subAccounts/${event.subAccountId}`).get(),
    event.bookingPageSlug ? db.doc(`subAccounts/${event.subAccountId}/bookingPages/${event.bookingPageSlug}`).get() : Promise.resolve(null),
    paidWorkflows(event),
  ]);
  const sub = (subSnap.exists ? subSnap.data() : null) as SubAccountDoc | null;
  const page = (pageSnap?.data() ?? null) as BookingPage | null;
  const startAt = toDate(event.startAt);
  // Without a contact or readable times nothing past the status change runs.
  const runs = !!event.contactId && !!startAt && !!toDate(event.endAt);
  let why: string | null = null;
  if (!event.contactId) why = "the booking has no contact.";
  else if (!runs) why = "the booking's times can't be read.";
  else if (!contact || !sub) why = "the contact or workspace couldn't be read.";
  else if (!emailIsConfigured(sub)) why = "email isn't configured for this workspace.";
  else if (!contact.email) why = "the contact has no email address.";
  else if (contact.emailOptedOut) why = "the contact has opted out of email.";
  const emailTo = why ? null : contact!.email!;
  const reminders = runs && page?.remindersEnabled ? [...(page.reminderOffsetsMinutes ?? [])] : null;
  const started = runs ? workflows : [];
  const tz = typeof sub?.timezone === "string" && sub.timezone ? sub.timezone : "UTC";
  const rows: PreviewRow[] = [
    { label: "Mark paid", value: `${oneLine(event.title) || "Meeting"} at ${startAt ? `${fmtInTz(startAt, tz)} (${tz})` : "(no time)"}` },
    ...recordProvenanceRows(event.id, event),
    { label: "Deposit", value: typeof event.paymentAmount === "number" ? fmtMoney(event.paymentAmount, (event.paymentCurrency || "").toUpperCase()) : "(no amount recorded)" },
    {
      label: "Confirmation email",
      value: emailTo ? `Sent to ${oneLine(contact!.name) || "(unnamed)"} (${masked("email", emailTo)}) with a calendar invite and a new manage link` : `None: ${why}`,
    },
    { label: "Reminders", value: reminders?.length ? `Scheduled ${reminders.map((m) => `${m} min`).join(", ")} before the start, as the booking page sets` : "None" },
    { label: "Workflows that start", value: started.map((w) => `${w.name} (${w.id})`).join(", ") || "none" },
    { label: "Then", value: "The booking is confirmed: its payment hold stops expiring, the payment is recorded on the contact's timeline, and the old link in the payment email stops working." },
  ];
  const pinned = {
    eventId: event.id,
    contactId: event.contactId ?? null,
    emailTo,
    reminders,
    workflows: started.map((w) => ({ id: w.id, stepsFingerprint: w.stepsFingerprint })),
  };
  return { rows, pinned };
}

async function awaitingEvent(subAccountId: string, eventId: unknown): Promise<CalendarEvent> {
  const e = await tenantEvent(subAccountId, eventId);
  if (eventStatus(e) !== "awaiting_payment") {
    throw new CapabilityUserError(`Only a booking awaiting payment can be marked paid (this one is ${eventStatus(e)}).`);
  }
  return e;
}

export const BOOKING_PAYMENT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "find_awaiting_payment_bookings",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "See bookings still waiting on a deposit",
    description:
      "List this workspace's booking-page appointments that are 'awaiting payment' (a deposit was required and hasn't been confirmed), soonest first, with each one's event id. Use for 'who still needs to pay their deposit?'.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List bookings awaiting payment.",
    execute: async (ctx) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const scope = await territoryScopeFor(ctx);
      // Soonest first in the query (the events(subAccountId, status, startAt)
      // index), territory-filtered before the cap.
      const { docs, scanCapped } = await collectVisible(
        scope,
        getAdminDb()
          .collection("events")
          .where("subAccountId", "==", ctx.subAccountId!)
          .where("status", "==", "awaiting_payment")
          .orderBy("startAt", "asc"),
        { want: SHOWN + 1, maxScan: MAX_SCAN }
      );
      if (docs.length === 0) {
        return scanCapped
          ? { resultText: `None of the first ${MAX_SCAN} bookings awaiting payment are in your territories — see the Calendar.`, truncated: true as const }
          : { resultText: "No bookings are waiting on a deposit." };
      }
      const more = docs.length > SHOWN;
      const shown = docs
        .slice(0, SHOWN)
        .map((d) => {
          const e = d.data() as CalendarEvent;
          return {
            id: d.id,
            title: oneLine(e.title) || "(untitled)",
            start: toDate(e.startAt),
            contactId: typeof e.contactId === "string" ? e.contactId : null,
            page: e.bookingPageSlug ?? null,
          };
        });
      const names = await contactNamesById(ctx.subAccountId!, shown.map((r) => r.contactId), scope);
      const lines = shown.map(
        (r) =>
          `- ${r.title} — ${r.start ? fmtInTz(r.start, tz) : "no time"}${
            r.contactId ? `, ${names.get(r.contactId) ?? r.contactId}` : ""
          }${r.page ? `, page: ${r.page}` : ""}, id: ${r.id}`
      );
      const head = more ? `the soonest ${SHOWN}` : `${shown.length}`;
      const tail = more ? "\n(More are waiting — see the Calendar.)" : scanCapped ? `\n(Only the first ${MAX_SCAN} bookings awaiting payment were checked — see the Calendar.)` : "";
      return {
        resultText: `Bookings awaiting payment (${head}, times in ${tz}):\n${lines.join("\n")}${tail}`,
        ...(more || scanCapped ? { truncated: true as const } : {}),
      };
    },
  },
  {
    name: "mark_booking_paid",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Confirm a booking's deposit was paid (a person approves; emails the customer)",
    description:
      "Mark an 'awaiting payment' booking as paid, as the calendar's Mark paid button does: the booking is confirmed, the customer is emailed their confirmation, its reminders are scheduled and the booking.confirmed workflows start, so it is queued for a person to approve. Find the event id with find_awaiting_payment_bookings. Only for a payment that arrived outside the app; card deposits confirm themselves.",
    parameters: {
      type: "object",
      properties: { eventId: { type: "string", description: "The booking's event id (from find_awaiting_payment_bookings)." } },
      required: ["eventId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const eventId = str(raw, "eventId");
      return isDocId(eventId) ? { ok: true, args: { eventId } } : { ok: false, error: "an eventId is required (find_awaiting_payment_bookings)" };
    },
    summarize: () => "Mark a booking paid.",
    // Agent-only; were it ever offered in chat, it is refused before a card.
    chatRefusal: () => CHAT_REFUSAL,
    // As the Mark paid route gates it: on the booking's own territory.
    approvalTarget: async (ctx, args) => {
      const e = await tenantEvent(ctx.subAccountId!, args.eventId);
      return { contactId: null, territoryId: e.territoryId ?? null, scoped: true };
    },
    preview: async (ctx, args) => paidPlan(await awaitingEvent(ctx.subAccountId!, args.eventId)),
    execute: async (ctx, args) => {
      // Chat and any unapproved call: refused here, whatever surface asked.
      if (!ctx.approved) throw new CapabilityUserError(CHAT_REFUSAL);
      const e = await awaitingEvent(ctx.subAccountId!, args.eventId);
      const { pinned } = await paidPlan(e);
      if (canonical(pinned) !== canonical(ctx.approved.pinned ?? null)) {
        throw new CapabilityUserError("The booking's contact, its confirmation email, reminders or the workflows it starts changed since this was reviewed; nothing was changed.");
      }
      const out = await markBookingPaidServerSide({
        eventId: e.id,
        expectSubAccountId: ctx.subAccountId!,
        paidByUid: ctx.uid,
        expect: {
          contactId: pinned.contactId,
          emailTo: pinned.emailTo,
          stepsFingerprints: Object.fromEntries(pinned.workflows.map((w) => [w.id, w.stepsFingerprint])),
        },
      });
      if (!out.ok) {
        const why: Partial<Record<typeof out.code, string>> = {
          bad_status: "It is no longer awaiting payment (confirmed or cancelled meanwhile); nothing more was done.",
          contact_changed: "The booking's contact changed since this was reviewed; it was not marked paid.",
        };
        throw new CapabilityUserError(why[out.code] ?? "The booking couldn't be marked paid.");
      }
      const email = out.emailWithheld
        ? " The confirmation email and its reminders were NOT sent: the recipient changed after approval."
        : pinned.emailTo
          ? " Its confirmation email goes only to the reviewed address."
          : "";
      return { resultText: `Marked the booking paid; it is confirmed.${email}`, ref: { kind: "event", id: e.id } };
    },
  },
];
