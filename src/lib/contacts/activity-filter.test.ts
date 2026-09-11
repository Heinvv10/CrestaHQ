import { describe, expect, it } from "vitest";
import { activityCategory, matchesActivityFilter } from "./activity-filter";

describe("activity timeline filter", () => {
  it("routes inbound and outbound messages to Messages", () => {
    expect(activityCategory("sms_received")).toBe("messages");
    expect(activityCategory("whatsapp_received")).toBe("messages");
    expect(activityCategory("email_received")).toBe("messages");
    expect(activityCategory("messenger_received")).toBe("messages");
    expect(activityCategory("instagram_received")).toBe("messages");
    expect(activityCategory("sms_sent")).toBe("messages");
  });

  it("routes tasks, notes, pipeline and automations to their chips", () => {
    expect(activityCategory("task_created")).toBe("tasks");
    expect(activityCategory("task_completed")).toBe("tasks");
    expect(activityCategory("note_added")).toBe("notes");
    expect(activityCategory("pipeline_moved")).toBe("pipeline");
    expect(activityCategory("automation_step_skipped")).toBe("automations");
  });

  it("sends everything unplaced to Other, and All matches all", () => {
    expect(activityCategory("quote_sent")).toBe("other");
    expect(matchesActivityFilter("quote_sent", "all")).toBe(true);
    expect(matchesActivityFilter("sms_received", "tasks")).toBe(false);
    expect(matchesActivityFilter("sms_received", "messages")).toBe(true);
  });
});
