import { describe, expect, it } from "vitest";
import { usageDebtState, usageGraceEndsAt, workspaceBillingState } from "@/lib/billing/usage-debt";
import { BILLING_GRACE_DAYS, type SubAccountBilling } from "@/types/billing";
import type { UsageOverdue } from "@/types/tenancy";

/** The guard's state machine: none / banner (grace) / wall (lapsed), and where it fails open. */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 10, 20, 10, 0));
const dueDaysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);
/** `paywallSince` defaults to long ago: the wall has been on for ages unless a test says otherwise. */
const overdue = (
  since: Date | null,
  paywall: boolean | undefined,
  paywallSince: Date | null | undefined = new Date(0),
): UsageOverdue =>
  ({ chargeId: "usage_sa1_2026-10", since, amountCents: 5000, currency: "zar", usageMonth: "2026-10", paywall, paywallSince }) as UsageOverdue;
const billing = (status: SubAccountBilling["status"], extra: Partial<SubAccountBilling> = {}): SubAccountBilling =>
  ({ status, ...extra }) as SubAccountBilling;

describe("usageDebtState", () => {
  it("none: no flag, or a flag with no readable due date", () => {
    expect(usageDebtState(null, NOW)).toBe("none");
    expect(usageDebtState(undefined, NOW)).toBe("none");
    expect(usageDebtState(overdue(null, true), NOW)).toBe("none");
    expect(usageDebtState(overdue("nonsense" as unknown as Date, true), NOW)).toBe("none");
  });

  it("banner: inside the grace period, whatever the wall setting", () => {
    expect(usageDebtState(overdue(dueDaysAgo(1), true), NOW)).toBe("grace");
    expect(usageDebtState(overdue(dueDaysAgo(BILLING_GRACE_DAYS - 1), true), NOW)).toBe("grace");
  });

  it("wall: past the grace period AND the wall is on", () => {
    expect(usageDebtState(overdue(dueDaysAgo(BILLING_GRACE_DAYS + 1), true), NOW)).toBe("lapsed");
  });

  it("the wall stays dark unless paywall is exactly true", () => {
    const old = dueDaysAgo(BILLING_GRACE_DAYS + 30);
    expect(usageDebtState(overdue(old, false), NOW)).toBe("grace");
    expect(usageDebtState(overdue(old, undefined), NOW)).toBe("grace");
    expect(usageDebtState(overdue(old, "true" as unknown as boolean), NOW)).toBe("grace");
    expect(usageDebtState(overdue(old, 1 as unknown as boolean), NOW)).toBe("grace");
  });
});

describe("turning the paywall on starts its own 7 days", () => {
  const old = dueDaysAgo(400);

  it("a long-overdue client is not walled the moment the paywall is turned on", () => {
    expect(usageDebtState(overdue(old, true, dueDaysAgo(1)), NOW)).toBe("grace");
    expect(usageDebtState(overdue(old, true, dueDaysAgo(BILLING_GRACE_DAYS - 1)), NOW)).toBe("grace");
  });

  it("then the wall falls 7 days after it was turned on", () => {
    expect(usageDebtState(overdue(old, true, dueDaysAgo(BILLING_GRACE_DAYS + 1)), NOW)).toBe("lapsed");
  });

  it("the countdown targets the later of due+7 and enabled+7", () => {
    const enabled = dueDaysAgo(1);
    expect(usageGraceEndsAt(overdue(old, true, enabled))).toBe(enabled.getTime() + BILLING_GRACE_DAYS * DAY);
    const due = dueDaysAgo(2);
    expect(usageGraceEndsAt(overdue(due, true, dueDaysAgo(30)))).toBe(due.getTime() + BILLING_GRACE_DAYS * DAY);
  });

  it("a paywall with no readable turned-on date is a banner, never a wall (fails open)", () => {
    expect(usageDebtState(overdue(old, true, null), NOW)).toBe("grace");
    expect(usageDebtState({ ...overdue(old, true), paywallSince: undefined }, NOW)).toBe("grace");
    expect(usageDebtState(overdue(old, true, "x" as unknown as Date), NOW)).toBe("grace");
    expect(usageGraceEndsAt(overdue(old, true, null))).toBeNull();
  });
});

describe("usageGraceEndsAt", () => {
  it("is the countdown target only while the wall is on", () => {
    const since = dueDaysAgo(2);
    expect(usageGraceEndsAt(overdue(since, true))).toBe(since.getTime() + BILLING_GRACE_DAYS * DAY);
    expect(usageGraceEndsAt(overdue(since, false))).toBeNull();
    expect(usageGraceEndsAt(null)).toBeNull();
    expect(usageGraceEndsAt(overdue(null, true))).toBeNull();
  });
});

describe("workspaceBillingState", () => {
  it("a comped or active client with no flag is untouched", () => {
    expect(workspaceBillingState(null, null, NOW)).toEqual({ state: "comped", blockedBy: null });
    expect(workspaceBillingState(billing("active"), null, NOW)).toEqual({ state: "active", blockedBy: null });
  });

  it("a comped client can still owe usage: banner, then wall", () => {
    expect(workspaceBillingState(null, overdue(dueDaysAgo(2), true), NOW)).toEqual({ state: "grace", blockedBy: "usage" });
    expect(workspaceBillingState(null, overdue(dueDaysAgo(20), true), NOW)).toEqual({ state: "lapsed", blockedBy: "usage" });
  });

  it("with the wall off a comped client is never walled, however old the debt", () => {
    expect(workspaceBillingState(null, overdue(dueDaysAgo(400), false), NOW)).toEqual({ state: "grace", blockedBy: "usage" });
  });

  it("an unpaid subscription shows first, and a plan grace outranks a usage banner", () => {
    expect(workspaceBillingState(billing("pending"), overdue(dueDaysAgo(20), true), NOW)).toEqual({ state: "pending", blockedBy: "plan" });
    expect(workspaceBillingState(billing("canceled"), overdue(dueDaysAgo(20), true), NOW)).toEqual({ state: "lapsed", blockedBy: "plan" });
    const pastDue = billing("past_due", { graceUntil: new Date(NOW.getTime() + 3 * DAY) });
    expect(workspaceBillingState(pastDue, overdue(dueDaysAgo(2), true), NOW)).toEqual({ state: "grace", blockedBy: "plan" });
  });
});
