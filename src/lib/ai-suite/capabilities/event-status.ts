import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { changeEventStatus, statusChangeError } from "@/lib/server/event-status-service";
import { planCancelNotice, type CancelNoticeExpect } from "@/lib/server/event-cancel-notice";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { eventStatus, type CalendarEvent, type EventNotifySkipReason, type EventStatus } from "@/types/events";
import { CapabilityUserError, type AiSuiteCapability, type PreviewRow } from "./types";
import { agentActor, str, toDate } from "./helpers";
import { hasUnsafeText, messageBody, oneLine, plainSpaces, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { masked } from "./conversation-send-support";
import { recordProvenanceRows } from "./record-provenance";
import { activeWorkflowsOn } from "./workflow-support";

/**
 * set_event_status for API agents (AGENT_API_V1_PLAN.md, PR12), through the
 * status route's own service (changeEventStatus). `completed` / `no_show`
 * are direct writes whose booking.showed / booking.no_show enrolments are
 * held for approval (ruling Q, via `actor`). `cancelled` emails the attendee,
 * so a person approves it (outbound): the preview shows the exact notice,
 * its recipient and channel (event-cancel-notice.ts), pinned, and the cancel
 * sends only that notice (`expectNotice`).
 */

const STATUSES = ["completed", "no_show", "cancelled"] as const;
const WHY_NONE: Partial<Record<EventNotifySkipReason, string>> = {
  no_contact: "the appointment has no contact.",
  email_not_configured: "email isn't configured for this workspace.",
  no_contact_email: "the contact has no email address.",
  contact_opted_out: "the contact has opted out of email.",
  missing_records: "the contact or workspace couldn't be read.",
  bad_timestamps: "the appointment's times can't be read.",
};

async function tenantEvent(subAccountId: string, eventId: unknown): Promise<CalendarEvent> {
  const snap = isDocId(eventId) ? await getAdminDb().doc(`events/${eventId}`).get() : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That appointment isn't in this workspace.");
  return { ...(data as Omit<CalendarEvent, "id">), id: snap!.id };
}

/** The active booking.cancelled workflows a cancel starts (as a person's
 *  cancel does), matched as the engine matches them, with their steps'
 *  fingerprints. */
async function cancelWorkflows(event: CalendarEvent) {
  if (!event.contactId) return [];
  return (await activeWorkflowsOn(event.subAccountId, "booking.cancelled")).filter((w) => {
    const slug = (w.trigger as { bookingPageSlug?: string | null } | undefined)?.bookingPageSlug;
    return !slug || slug === (event.bookingPageSlug ?? null);
  });
}
/** What is pinned of those workflows: which, and their exact steps. */
const workflowPin = (ws: Awaited<ReturnType<typeof cancelWorkflows>>) => ws.map((w) => ({ id: w.id, stepsFingerprint: w.stepsFingerprint }));

/** The notice a cancel would send (null: none), and how the approver reads it. */
async function noticePlan(event: CalendarEvent): Promise<{ notice: CancelNoticeExpect | null; rows: PreviewRow[] }> {
  const n = await planCancelNotice(event);
  if (!n.ok) return { notice: null, rows: [{ label: "Cancellation notice", value: `None: ${WHY_NONE[n.reason] ?? n.reason}` }] };
  // Shown as sent, but for the kind of space.
  if (messageBody(n.text) !== plainSpaces(n.text) || oneLine(n.subject) !== plainSpaces(n.subject)) {
    throw new CapabilityUserError("The cancellation notice has characters or spacing that can't be shown exactly as sent.");
  }
  return {
    notice: { to: n.to, subject: n.subject, text: n.text, html: n.html },
    rows: [
      { label: "Cancellation notice", value: `Sent to ${oneLine(n.name) || "(unnamed)"} (${masked("email", n.to)}) by email` },
      { label: "Subject", value: oneLine(n.subject) },
      { label: "Message", value: messageBody(n.text)!, multiline: true },
    ],
  };
}

export const EVENT_STATUS_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "set_event_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Mark an appointment completed, no-show or cancelled (cancelling: a person approves)",
    description:
      "Set an appointment's status, as the calendar's status buttons do: completed or no_show (only once it has started) or cancelled. Cancelling emails the attendee, so it is queued for a person to approve; workflows the change starts are held for approval.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The appointment's id (from find_events)." },
        status: { type: "string", enum: [...STATUSES] },
        reason: { type: "string", description: "Optional note for the contact's timeline." },
      },
      required: ["eventId", "status"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const [eventId, status, reason] = [str(raw, "eventId"), str(raw, "status"), str(raw, "reason")];
      if (!isDocId(eventId)) return { ok: false, error: "an eventId is required" };
      if (!(STATUSES as readonly string[]).includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join(", ")}` };
      if (hasUnsafeText(reason)) return { ok: false, error: `the reason ${UNSAFE_TEXT_MESSAGE}` };
      return { ok: true, args: { eventId, status, ...(reason ? { reason } : {}) } };
    },
    summarize: (args) => `Mark an appointment ${args.status}.`,
    approvalFor: (args) => (args.status === "cancelled" ? "outbound" : undefined),
    approvalHint: { approval: "outbound", when: "status=cancelled" },
    approvalTarget: async (ctx, args) => {
      const e = await tenantEvent(ctx.subAccountId!, args.eventId);
      return { contactId: isDocId(e.contactId) ? e.contactId : null, territoryId: (e as { territoryId?: string }).territoryId ?? null, scoped: true };
    },
    preview: async (ctx, args) => {
      const e = await tenantEvent(ctx.subAccountId!, args.eventId);
      const refused = eventStatus(e) === "cancelled" ? "That appointment is already cancelled." : statusChangeError(e, "cancelled", 0);
      if (refused) throw new CapabilityUserError(refused);
      const [plan, workflows] = await Promise.all([noticePlan(e), cancelWorkflows(e)]);
      return {
        rows: [
          { label: "Cancel", value: `${oneLine(e.title) || "Meeting"} at ${toDate(e.startAt)?.toISOString() ?? "(no time)"}` },
          ...recordProvenanceRows(e.id, e),
          ...(args.reason ? [{ label: "Reason (timeline)", value: oneLine(args.reason) }] : []),
          ...plan.rows,
          {
            label: "Workflows that start",
            value: workflows.map((w) => `${w.name} (${w.id})`).join(", ") || "none",
          },
          { label: "Then", value: "The slot is freed, and those workflows run, as when a person cancels it." },
        ],
        pinned: { eventId: e.id, notice: plan.notice, workflows: workflowPin(workflows) },
      };
    },
    execute: async (ctx, args) => {
      const e = await tenantEvent(ctx.subAccountId!, args.eventId);
      const status = args.status as EventStatus;
      const reason = (args.reason as string | undefined) ?? "";
      if (status === "cancelled") {
        if (!ctx.approved) throw new CapabilityUserError("Cancelling an appointment needs a person's approval.");
        const pinned = (ctx.approved.pinned?.notice ?? null) as CancelNoticeExpect | null;
        if (canonical((await noticePlan(e)).notice) !== canonical(pinned)) {
          throw new CapabilityUserError("The appointment's contact or its cancellation notice changed since this was reviewed; nothing was changed.");
        }
        if (canonical(workflowPin(await cancelWorkflows(e))) !== canonical(ctx.approved.pinned?.workflows ?? [])) {
          throw new CapabilityUserError("The workflows a cancel starts (or their steps) changed since this was reviewed; nothing was changed.");
        }
        const out = await changeEventStatus(e, status, reason, { expectNotice: pinned });
        if (!out.ok) throw new CapabilityUserError(out.error ?? "The appointment couldn't be cancelled.");
        if (out.noop) return { resultText: "It was already cancelled (by someone else); nothing more was done.", ref: { kind: "event", id: e.id } };
        const sent = out.emailSent ? " The attendee was emailed." : out.emailSkipReason === "changed_since_approval" ? " The notice was NOT sent: it changed after approval." : "";
        return { resultText: `Cancelled the appointment.${sent}`, ref: { kind: "event", id: e.id } };
      }
      const out = await changeEventStatus(e, status, reason, { actor: agentActor(ctx, "set_event_status") });
      if (!out.ok) throw new CapabilityUserError(out.error ?? "The appointment's status couldn't be changed.");
      if (out.noop) return { resultText: `It is already ${status}.`, ref: { kind: "event", id: e.id } };
      return {
        resultText: `Marked the appointment ${status}.`,
        ref: { kind: "event", id: e.id },
        ...(out.held?.length ? { held: out.held } : {}),
        ...(out.holdFailures?.length ? { holdFailures: out.holdFailures } : {}),
      };
    },
  },
];
