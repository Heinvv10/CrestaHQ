import {
  isStaleSending,
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
  m: Pick<ScheduledMessageView, "status" | "sendAt"> &
    Partial<Pick<ScheduledMessageView, "claimedAt">>,
  when: string,
  nowMs: number
): { tone: ScheduledItemTone; label: string; action: "cancel" | "dismiss" | null } {
  switch (m.status) {
    case "sending":
      // A worker killed mid-send leaves this forever; past the limit it is an
      // unknown outcome like any other, and can be dismissed.
      return isStaleSending(viewTimes(m), nowMs)
        ? { tone: "unconfirmed", label: `${UNCONFIRMED_LABEL} (scheduled for ${when})`, action: "dismiss" }
        : { tone: "sending", label: "Sending…", action: null };
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

/** The view's ISO times as the millis isStaleSending reads. */
export function viewTimes(
  m: Pick<ScheduledMessageView, "status" | "sendAt"> & Partial<Pick<ScheduledMessageView, "claimedAt">>
) {
  const claimed = m.claimedAt ? Date.parse(m.claimedAt) : Number.NaN;
  return {
    status: m.status,
    claimedAtMs: Number.isFinite(claimed) ? claimed : null,
    sendAtMs: Date.parse(m.sendAt) || 0,
  };
}
