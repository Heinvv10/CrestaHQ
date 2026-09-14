/**
 * Display formatting for the Reputation overview. The numbers themselves come
 * from the API (lib/reputation/overview.ts); nothing here computes a metric.
 */

export const fmtRating = (v: number | null) => (v === null ? "—" : v.toFixed(1));

export const fmtPercent = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export function fmtHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${+h.toFixed(1)} h`;
  return `${+(h / 24).toFixed(1)} days`;
}

/** "+2" / "−0.4" / "0" — `digits` for averages. */
export function fmtDelta(v: number, digits = 0): string {
  const r = +v.toFixed(digits);
  if (r === 0) return "no change";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(digits)}`;
}

/** Buckets start at UTC midnight, so they are labelled in UTC. */
export function fmtBucket(iso: string, bucket: "week" | "month"): string {
  return new Date(iso).toLocaleDateString("en-GB", bucket === "month"
    ? { month: "short", year: "numeric", timeZone: "UTC" }
    : { day: "numeric", month: "short", timeZone: "UTC" });
}

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export const RANGE_LABEL = { "30d": "Last 30 days", "90d": "Last 90 days", "365d": "Last 12 months", all: "All time" } as const;
export const PREVIOUS_LABEL = { "30d": "previous 30 days", "90d": "previous 90 days", "365d": "previous 12 months", all: "" } as const;

export const CHANNEL_LABEL: Record<string, string> = {
  sms: "SMS",
  whatsapp_template: "WhatsApp (template)",
  whatsapp_manual: "WhatsApp (in-window)",
};
