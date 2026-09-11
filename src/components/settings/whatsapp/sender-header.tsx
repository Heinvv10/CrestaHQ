"use client";

import { flagForDisplayNumber } from "./dial-flag";
import { RATING_LABEL, type WaPhoneStatus, type WaQualityRating } from "./types";

/**
 * One row like GHL's Numbers list: flag, number, verified name, connection
 * pill and the quality badge — all from the LIVE phone-number node, so what
 * the operator sees is what Meta says right now, not the hourly reading.
 */

const RATING_TONE: Record<WaQualityRating, string> = {
  GREEN: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  YELLOW: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  RED: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  UNKNOWN: "bg-muted text-muted-foreground",
};

export function SenderHeader({ phone }: { phone: WaPhoneStatus }) {
  const flag = flagForDisplayNumber(phone.displayPhoneNumber);
  const connected = phone.status === "CONNECTED";
  return (
    <section className="rounded-2xl border bg-card p-5" data-testid="wa-sender-header">
      <div className="flex flex-wrap items-center gap-3">
        {flag && (
          <span className="text-2xl leading-none" aria-hidden data-testid="wa-settings-flag">
            {flag}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold" data-testid="wa-settings-number">
            {phone.displayPhoneNumber ?? "Number unavailable"}
          </p>
          <p className="text-sm text-muted-foreground" data-testid="wa-settings-name">
            {phone.verifiedName ?? "No verified name"}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
            connected ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"
          }`}
          data-testid="wa-settings-connected"
        >
          {connected ? "Connected" : (phone.status ?? "Unknown")}
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${RATING_TONE[phone.qualityRating]}`}
          title="Meta's quality rating for this number, polled hourly."
          data-testid="wa-quality-badge"
          data-rating={phone.qualityRating}
        >
          Quality: {RATING_LABEL[phone.qualityRating]}
        </span>
      </div>
    </section>
  );
}
