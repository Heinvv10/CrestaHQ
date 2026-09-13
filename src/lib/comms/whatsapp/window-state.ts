import { DEFAULT_WA_WINDOW_HOURS, isWithinServiceWindow } from "./send-mode";

/**
 * SP2 T8 — the WhatsApp 24-hour service window as the composer shows it.
 *
 * Pure and client-safe. Open vs closed is decided by `isWithinServiceWindow`,
 * the SAME function `resolveWaSendMode` uses on the send path, so the
 * composer cannot disagree with the route about whether the window is open.
 * This module only adds what a display needs on top: when it closes. The
 * route's 409 `session_window_closed` stays the authority.
 */

export type WaWindowState =
  /** The rail has no service window (the bridge) — show nothing. */
  | { kind: "exempt" }
  | { kind: "open"; closesAt: Date; msLeft: number }
  /** `lastInboundAt` null = the contact has never messaged on WhatsApp. */
  | { kind: "closed"; lastInboundAt: Date | null };

export function waWindowState(input: {
  enforcesWindow: boolean;
  lastInboundAt: Date | null;
  now: Date;
  windowHours?: number;
}): WaWindowState {
  if (!input.enforcesWindow) return { kind: "exempt" };
  const hours = input.windowHours ?? DEFAULT_WA_WINDOW_HOURS;
  if (!isWithinServiceWindow(input.lastInboundAt, input.now, hours)) {
    return { kind: "closed", lastInboundAt: input.lastInboundAt };
  }
  // Non-null: isWithinServiceWindow is false for a null lastInboundAt.
  const closesAt = new Date(input.lastInboundAt!.getTime() + hours * 3600_000);
  return { kind: "open", closesAt, msLeft: closesAt.getTime() - input.now.getTime() };
}

/** "3h 12m" / "45m" / "<1m" — minute granularity, rounded down. */
export function formatWindowLeft(msLeft: number): string {
  const minutes = Math.floor(msLeft / 60_000);
  if (minutes < 1) return "<1m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function waWindowLabel(state: WaWindowState): string | null {
  switch (state.kind) {
    case "exempt":
      return null;
    case "open":
      return `Window open · closes in ${formatWindowLeft(state.msLeft)}`;
    case "closed":
      return "Window closed — only an approved template can be sent";
  }
}

type MessageRow = {
  direction?: string;
  createdAt?: { toDate?: () => Date } | null;
};

/**
 * The newest inbound row's time, from rows ordered newest-first. Mirrors the
 * server's `readLastInboundAt` (send-dispatch.ts): same ordering, first
 * inbound wins, and an inbound row without a timestamp counts as none.
 */
export function latestInboundAt(rowsNewestFirst: readonly MessageRow[]): Date | null {
  for (const row of rowsNewestFirst) {
    if (row.direction === "inbound") return row.createdAt?.toDate?.() ?? null;
  }
  return null;
}
