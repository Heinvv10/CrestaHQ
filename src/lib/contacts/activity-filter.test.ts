import { describe, expect, it } from "vitest";
import type { ActivityType } from "@/types/contacts";
import {
  ACTIVITY_CHIP,
  activityCategory,
  matchesActivityFilter,
  type ActivityChip,
} from "./activity-filter";

/** Every ActivityType, spelled out. The two type-level checks below fail
 *  the build if this list and the union ever diverge in either direction. */
const ALL_TYPES = [
  "note_added",
  "booking_created",
  "pipeline_moved",
  "task_created",
  "task_completed",
  "form_submitted",
  "email_sent",
  "sms_sent",
  "whatsapp_sent",
  "sms_received",
  "whatsapp_received",
  "email_received",
  "email_suppressed",
  "messenger_received",
  "instagram_received",
  "webchat_received",
  "messenger_sent",
  "instagram_sent",
  "automation_started",
  "automation_step_sent",
  "automation_step_skipped",
  "automation_completed",
  "automation_failed",
  "ai_reply_sent",
  "ai_escalated",
  "ai_skipped",
  "voice_call_initiated",
  "voice_call_completed",
  "missed_call",
  "call_placed",
  "quiet_hours_held",
  "quote_sent",
  "quote_viewed",
  "quote_accepted",
  "quote_declined",
  "quote_marked_paid",
  "review_requested",
  "contact_territory_changed",
  "booking_page_booked",
  "booking_payment_received",
  "booking_cancelled",
  "booking_rescheduled",
  "booking_no_show",
  "booking_completed",
  "booking_reassigned",
  "meet_link_missing",
  "meet_room_owner_removed",
  "order_paid",
  "order_refunded",
  "webinar_registered",
  "webinar_joined",
  "webinar_completed",
  "webinar_cta_clicked",
] as const satisfies readonly ActivityType[];
type Missing = Exclude<ActivityType, (typeof ALL_TYPES)[number]>;
const _everyTypeListed: Missing extends never ? true : never = true;
void _everyTypeListed;

const CHIPS: ActivityChip[] = [
  "messages",
  "notes",
  "tasks",
  "pipeline",
  "automations",
  "other",
];

describe("activity timeline filter", () => {
  it("places every ActivityType on exactly one chip", () => {
    for (const type of ALL_TYPES) {
      expect(CHIPS, `${type} is unplaced`).toContain(ACTIVITY_CHIP[type]);
      expect(activityCategory(type)).toBe(ACTIVITY_CHIP[type]);
    }
    expect(Object.keys(ACTIVITY_CHIP).sort()).toEqual([...ALL_TYPES].sort());
  });

  it("routes inbound and outbound messages to Messages", () => {
    for (const type of [
      "sms_received",
      "whatsapp_received",
      "email_received",
      "messenger_received",
      "instagram_received",
      "webchat_received",
      "sms_sent",
      "email_sent",
    ] as const) {
      expect(activityCategory(type)).toBe("messages");
    }
  });

  it("routes tasks, notes, pipeline and automations to their chips", () => {
    expect(activityCategory("task_created")).toBe("tasks");
    expect(activityCategory("task_completed")).toBe("tasks");
    expect(activityCategory("note_added")).toBe("notes");
    expect(activityCategory("pipeline_moved")).toBe("pipeline");
    expect(activityCategory("automation_started")).toBe("automations");
    expect(activityCategory("automation_step_skipped")).toBe("automations");
  });

  it("keeps the rest in Other, and All matches everything", () => {
    expect(activityCategory("quote_sent")).toBe("other");
    expect(activityCategory("webinar_joined")).toBe("other");
    expect(matchesActivityFilter("quote_sent", "all")).toBe(true);
    expect(matchesActivityFilter("sms_received", "tasks")).toBe(false);
    expect(matchesActivityFilter("sms_received", "messages")).toBe(true);
  });
});
