import { describe, expect, it } from "vitest";
import { scheduledItemState } from "./scheduled-item";

const NOW = Date.parse("2026-09-13T10:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const state = (status: string, offsetMs: number) =>
  scheduledItemState({ status: status as never, sendAt: at(offsetMs) }, "WHEN", NOW);

describe("scheduledItemState", () => {
  it("pending in the future: scheduled, cancellable", () => {
    expect(state("pending", 3600_000)).toEqual({
      tone: "pending",
      label: "Scheduled for WHEN",
      action: "cancel",
    });
  });

  it("pending up to 15 minutes past its time is still just scheduled", () => {
    expect(state("pending", -15 * 60_000).tone).toBe("pending");
  });

  it("pending more than 15 minutes past its time shows as overdue", () => {
    const s = state("pending", -16 * 60_000);
    expect(s.tone).toBe("overdue");
    expect(s.label).toMatch(/^Overdue/);
    expect(s.action).toBe("cancel");
  });

  it("an unconfirmed send is NEVER called 'Not sent'", () => {
    const s = state("unconfirmed", -60_000);
    expect(s.tone).toBe("unconfirmed");
    expect(s.label).toMatch(/^Not confirmed sent — check the conversation before resending/);
    expect(s.label).not.toMatch(/not sent/i);
    expect(s.action).toBe("dismiss");
  });

  it("failed says not sent and can be dismissed; sending offers nothing", () => {
    expect(state("failed", -60_000)).toMatchObject({ tone: "failed", action: "dismiss" });
    expect(state("failed", -60_000).label).toMatch(/^Not sent/);
    expect(state("sending", 0)).toEqual({ tone: "sending", label: "Sending…", action: null });
  });
});
