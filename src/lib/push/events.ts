import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { sendPushForEvent } from "@/lib/push/send";
import type { EmitWebhookEventInput } from "@/lib/api/webhooks/dispatch";

/**
 * Push consumer for the webhook event stream — the second internal
 * subscriber at the emitWebhookEvent dispatch point (before the
 * API-subscription early-return, so push fires even when no external
 * webhook is registered).
 *
 * The four speed-to-lead events (locked v1 pick) plus the two quote
 * outcomes notify; everything else is a silent no-op. Payloads arrive as
 * `unknown` (the wire payloads built at each emit site), so every field
 * read here is defensive — a shape drift degrades the notification copy,
 * never throws.
 */

const NEW_LEAD_SOURCE_LABELS: Record<string, string> = {
  "website-form": "Website form",
  "web-chat": "Web chat",
  "booking-page": "Booking page",
  community: "Community",
  website: "Website",
  referral: "Referral",
  ads: "Ads",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  voice: "Voice",
};

const CHANNEL_LABELS: Record<string, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

/** The whole push body for a contact an API agent created. */
export const AGENT_CONTACT_PUSH_BODY = "New contact added by an API agent";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** The contact's territory, so the send-time gate can keep a scoped
 *  collaborator from seeing a preview for a contact they can't open. The
 *  wire payload doesn't carry it, so read the contact. `undefined` when the
 *  event has no contact (unrestricted); `null` when the contact is untagged. */
export async function contactTerritoryId(
  contactId: string | null,
): Promise<string | null | undefined> {
  if (!contactId) return undefined;
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  return str(snap.data()?.territoryId);
}

export async function dispatchPushForWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<void> {
  try {
    const payload = rec(input.payload);
    const base = {
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
    };

    switch (input.type) {
      case "contact.created": {
        const contact = rec(payload.contact);
        const id = str(contact.id);
        if (input.byAgent) {
          // Fixed copy: no agent-chosen name or source reaches a phone.
          await sendPushForEvent({
            ...base,
            title: "New contact",
            body: AGENT_CONTACT_PUSH_BODY,
            url: id
              ? `/sa/${input.subAccountId}/contacts/${id}`
              : `/sa/${input.subAccountId}/contacts`,
            tag: id ? `lead-${id}` : undefined,
            territoryId: str(contact.territory_id),
          });
          return;
        }
        const name = str(contact.name) ?? "New contact";
        const source = str(contact.source);
        const sourceLabel = source
          ? (NEW_LEAD_SOURCE_LABELS[source] ??
            source.charAt(0).toUpperCase() + source.slice(1))
          : null;
        await sendPushForEvent({
          ...base,
          title: "New lead",
          body: sourceLabel ? `${name} · ${sourceLabel}` : name,
          url: id
            ? `/sa/${input.subAccountId}/contacts/${id}`
            : `/sa/${input.subAccountId}/contacts`,
          tag: id ? `lead-${id}` : undefined,
          territoryId: str(contact.territory_id),
        });
        return;
      }
      case "booking.created": {
        const booking = rec(payload.booking);
        const title = str(booking.title) ?? "New booking";
        const startAt = str(booking.start_at);
        // Format in the booking page's timezone (threaded through the
        // webhook payload) — without it toLocaleString falls back to the
        // server's zone (UTC in prod), showing the wrong time. Falls back
        // to the old behavior only when a timezone isn't available.
        const tz = str(booking.timezone);
        const when = startAt
          ? new Date(startAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              ...(tz ? { timeZone: tz } : {}),
            })
          : null;
        await sendPushForEvent({
          ...base,
          title: "New booking",
          body: when ? `${title} · ${when}` : title,
          url: `/sa/${input.subAccountId}/calendar`,
          tag: str(booking.id) ? `booking-${str(booking.id)}` : undefined,
          territoryId: await contactTerritoryId(str(booking.contact_id)),
        });
        return;
      }
      case "message.received": {
        const message = rec(payload.message);
        const contactId = str(message.contact_id);
        const name = str(message.contact_name) ?? "Unknown contact";
        const channel = str(message.channel);
        const channelLabel = channel ? CHANNEL_LABELS[channel] : null;
        const preview = str(message.preview) ?? "";
        await sendPushForEvent({
          ...base,
          title: channelLabel ? `${name} · ${channelLabel}` : name,
          body: preview,
          url: contactId
            ? `/sa/${input.subAccountId}/conversations/${contactId}`
            : `/sa/${input.subAccountId}/conversations`,
          // Collapse per conversation — a rapid burst from one contact
          // replaces the previous notification instead of stacking.
          tag: contactId ? `msg-${contactId}` : undefined,
          territoryId: await contactTerritoryId(contactId),
        });
        return;
      }
      // The two quote outcomes: accepted is the money moment, declined is
      // the cue to follow up while it's warm. Deliberately NOT hung off
      // task.created (which also fires for manual/workflow tasks and would
      // double watchdog alerts) — the originating event is the hook.
      case "quote.accepted":
      case "quote.declined": {
        const quote = rec(payload.quote);
        const id = str(quote.id);
        const kindLabel = str(quote.kind) === "invoice" ? "Invoice" : "Quote";
        const number = str(quote.number);
        const total = typeof quote.total === "number" ? quote.total : null;
        const currency = str(quote.currency);
        const amount =
          total !== null
            ? `${currency ? `${currency} ` : ""}${total.toLocaleString()}`
            : null;
        await sendPushForEvent({
          ...base,
          title:
            input.type === "quote.accepted"
              ? `${kindLabel} accepted`
              : `${kindLabel} declined`,
          body: [number, amount].filter(Boolean).join(" · ") || kindLabel,
          url: id
            ? `/sa/${input.subAccountId}/quotes/${id}`
            : `/sa/${input.subAccountId}/quotes`,
          tag: id ? `quote-${id}` : undefined,
        });
        return;
      }
      case "call.missed": {
        const call = rec(payload.call);
        const contactId = str(call.contact_id);
        const name = str(call.contact_name);
        const from = str(call.from);
        await sendPushForEvent({
          ...base,
          title: "Missed call",
          body: name || from || "Unknown caller",
          url: contactId
            ? `/sa/${input.subAccountId}/contacts/${contactId}`
            : `/sa/${input.subAccountId}/contacts`,
          tag: contactId ? `call-${contactId}` : undefined,
          territoryId: await contactTerritoryId(contactId),
        });
        return;
      }
      default:
        return;
    }
  } catch (err) {
    console.warn("[push/events] dispatch failed", err);
  }
}
