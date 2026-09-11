import type { ActivityType } from "@/types/contacts";

/**
 * Chip filter for the contact Activity timeline. Purely client-side over
 * the already-loaded rows; a category is derived from the row's type so a
 * new ActivityType lands in "Other" until it is placed here.
 */

export type ActivityFilter =
  | "all"
  | "messages"
  | "notes"
  | "tasks"
  | "pipeline"
  | "automations"
  | "other";

export const ACTIVITY_FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "messages", label: "Messages" },
  { value: "notes", label: "Notes" },
  { value: "tasks", label: "Tasks" },
  { value: "pipeline", label: "Pipeline" },
  { value: "automations", label: "Automations" },
  { value: "other", label: "Other" },
];

const MESSAGE_TYPES = new Set<ActivityType>([
  "email_sent",
  "sms_sent",
  "whatsapp_sent",
  "messenger_sent",
  "instagram_sent",
  "email_received",
  "sms_received",
  "whatsapp_received",
  "messenger_received",
  "instagram_received",
  "ai_reply_sent",
  "missed_call",
  "voice_call_initiated",
  "voice_call_completed",
]);

/** Which chip (other than "all") a timeline row belongs to. A note row has
 *  no ActivityType, so callers pass `"note_added"` for notes. */
export function activityCategory(
  type: ActivityType
): Exclude<ActivityFilter, "all"> {
  if (type === "note_added") return "notes";
  if (type === "task_created" || type === "task_completed") return "tasks";
  if (type === "pipeline_moved") return "pipeline";
  if (type.startsWith("automation_")) return "automations";
  if (MESSAGE_TYPES.has(type)) return "messages";
  return "other";
}

export function matchesActivityFilter(
  type: ActivityType,
  filter: ActivityFilter
): boolean {
  return filter === "all" || activityCategory(type) === filter;
}
