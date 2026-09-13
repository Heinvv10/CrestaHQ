import {
  LATE_DELIVERY_LIMIT_MS,
  UNCONFIRMED_LABEL,
  type ScheduledMessageView,
} from "@/types/scheduled-messages";

export type ScheduledItemTone = "pending" | "overdue" | "sending" | "failed" | "unconfirmed";

/**
 * How a scheduled message reads in the thread. Pure, so the wording — above
 * all that an unconfirmed send is never called "Not sent" — is tested.
 *
 * `when` is the send time already formatted in the display zone.
 */
export function scheduledItemState(
  m: Pick<ScheduledMessageView, "status" | "sendAt">,
  when: string,
  nowMs: number
): { tone: ScheduledItemTone; label: string; action: "cancel" | "dismiss" | null } {
  switch (m.status) {
    case "sending":
      return { tone: "sending", label: "Sending…", action: null };
    case "failed":
      return { tone: "failed", label: `Not sent — was scheduled for ${when}`, action: "dismiss" };
    case "unconfirmed":
      return { tone: "unconfirmed", label: `${UNCONFIRMED_LABEL} (scheduled for ${when})`, action: "dismiss" };
    default: {
      // The worker refuses a delivery this late, so a pending message past the
      // limit will not go out as booked — say so rather than "Scheduled for".
      const overdue = nowMs - Date.parse(m.sendAt) > LATE_DELIVERY_LIMIT_MS;
      return overdue
        ? {
            tone: "overdue",
            label: `Overdue — was scheduled for ${when}; the scheduler hasn't delivered it`,
            action: "cancel",
          }
        : { tone: "pending", label: `Scheduled for ${when}`, action: "cancel" };
    }
  }
}
