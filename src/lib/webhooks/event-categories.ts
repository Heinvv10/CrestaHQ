import type { WebhookEventType } from "@/types/webhooks";

/**
 * Webhook event categories — the SINGLE source of truth shared by the
 * dashboard picker UI and the server-side create/update validation, so the
 * two can never drift.
 *
 * Product rule: a subscription targets exactly ONE category. The UI greys
 * out the other categories once one is selected; the subscription routes
 * reject a cross-category event list. To subscribe to more, create one
 * webhook per category.
 *
 * (This file imports only the type, so it's safe to use from client
 * components — no "server-only" guard.)
 */

export interface WebhookEventCategory {
  label: string;
  events: WebhookEventType[];
}

export const WEBHOOK_EVENT_CATEGORIES: WebhookEventCategory[] = [
  {
    label: "Contacts",
    events: ["contact.created", "contact.updated", "contact.deleted"],
  },
  {
    label: "Deals",
    events: [
      "deal.created",
      "deal.updated",
      "deal.deleted",
      "deal.stage.changed",
      "deal.won",
      "deal.lost",
    ],
  },
  {
    label: "Tasks & Events",
    events: ["task.created", "task.completed", "event.created"],
  },
  { label: "Forms", events: ["form.submitted"] },
  {
    label: "Quotes",
    events: [
      "quote.sent",
      "quote.viewed",
      "quote.accepted",
      "quote.declined",
      "quote.paid",
    ],
  },
  { label: "Bookings", events: ["booking.created", "booking.cancelled"] },
  {
    label: "AI Agents",
    events: [
      "voice.call.completed",
      "voice.call.captured",
      "webchat.lead.captured",
    ],
  },
  {
    label: "Workspace",
    events: ["member.invited", "member.added", "automation.completed"],
  },
  {
    label: "Conversations",
    events: ["message.received", "call.missed"],
  },
  // Payments v1 — the sub-account's own customers paying them by card.
  // REQUIRED, not cosmetic: `eventsAreSingleCategory()` returns false for any
  // event `categoryOf()` doesn't recognise, so an uncategorised event makes
  // every subscription containing it fail validation. TypeScript can't catch
  // that (this is a lookup, not an exhaustive Record) — add the category
  // whenever you add an event type.
  {
    label: "Payments",
    events: ["order.paid", "order.refunded"],
  },
];

/** The category (label) an event belongs to, or null if uncategorized. */
export function categoryOf(ev: WebhookEventType): string | null {
  return (
    WEBHOOK_EVENT_CATEGORIES.find((c) => c.events.includes(ev))?.label ?? null
  );
}

/** The single category covered by a set of events (null when none/empty). */
export function activeCategoryOf(
  events: Iterable<WebhookEventType>,
): string | null {
  for (const ev of events) {
    const c = categoryOf(ev);
    if (c) return c;
  }
  return null;
}

/**
 * True when every event belongs to the same category. An empty list passes
 * (it means the legacy "all events" wildcard — the routes handle whether to
 * allow that separately); any unknown event fails.
 */
export function eventsAreSingleCategory(events: WebhookEventType[]): boolean {
  if (events.length === 0) return true;
  const first = categoryOf(events[0]);
  if (first === null) return false;
  return events.every((ev) => categoryOf(ev) === first);
}
