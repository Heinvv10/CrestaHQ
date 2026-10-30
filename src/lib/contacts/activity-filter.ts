import type { ActivityType } from "@/types/contacts";

/**
 * Chip filter for the contact Activity timeline. Purely client-side over
 * the already-loaded rows. The chip table is a `Record<ActivityType, …>`,
 * so adding an ActivityType without placing it here is a compile error —
 * nothing can silently land in "Other".
 */

export type ActivityFilter =
  | "all"
  | "messages"
  | "notes"
  | "tasks"
  | "pipeline"
  | "automations"
  | "other";

export type ActivityChip = Exclude<ActivityFilter, "all">;

export const ACTIVITY_FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "messages", label: "Messages" },
  { value: "notes", label: "Notes" },
  { value: "tasks", label: "Tasks" },
  { value: "pipeline", label: "Pipeline" },
  { value: "automations", label: "Automations" },
  { value: "other", label: "Other" },
];

export const ACTIVITY_CHIP = {
  note_added: "notes",
  booking_created: "other",
  pipeline_moved: "pipeline",
  task_created: "tasks",
  task_completed: "tasks",
  form_submitted: "other",
  email_sent: "messages",
  sms_sent: "messages",
  whatsapp_sent: "messages",
  sms_received: "messages",
  whatsapp_received: "messages",
  email_received: "messages",
  email_suppressed: "messages",
  messenger_received: "messages",
  instagram_received: "messages",
  webchat_received: "messages",
  messenger_sent: "messages",
  instagram_sent: "messages",
  automation_started: "automations",
  automation_step_sent: "automations",
  automation_step_skipped: "automations",
  automation_completed: "automations",
  automation_failed: "automations",
  ai_reply_sent: "messages",
  ai_escalated: "other",
  ai_skipped: "other",
  voice_call_initiated: "messages",
  voice_call_completed: "messages",
  missed_call: "messages",
  call_placed: "messages",
  quiet_hours_held: "messages",
  quote_sent: "other",
  quote_viewed: "other",
  quote_accepted: "other",
  quote_declined: "other",
  quote_marked_paid: "other",
  review_requested: "other",
  contact_territory_changed: "other",
  booking_page_booked: "other",
  booking_payment_received: "other",
  booking_cancelled: "other",
  booking_rescheduled: "other",
  booking_no_show: "other",
  booking_completed: "other",
  booking_reassigned: "other",
  meet_link_missing: "other",
  order_paid: "other",
  order_refunded: "other",
  webinar_registered: "other",
  webinar_joined: "other",
  webinar_completed: "other",
  webinar_cta_clicked: "other",
} satisfies Record<ActivityType, ActivityChip>;

/** Which chip (other than "all") a timeline row belongs to. A note row has
 *  no ActivityType, so callers pass `"note_added"` for notes. */
export function activityCategory(type: ActivityType): ActivityChip {
  return ACTIVITY_CHIP[type];
}

export function matchesActivityFilter(
  type: ActivityType,
  filter: ActivityFilter
): boolean {
  return filter === "all" || activityCategory(type) === filter;
}
