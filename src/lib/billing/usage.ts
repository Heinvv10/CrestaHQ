/**
 * Constants and month helpers for monthly usage billing, shared by the
 * month-close job and its emails.
 *
 * Months are SERVER-LOCAL, like `usageMonthKey()` in usage-meter.ts: velo-server
 * runs Africa/Johannesburg, so a usage month ends at local midnight. (Upstream
 * uses UTC; not ported. A buyer copy on Vercel runs in UTC, so its months are UTC.)
 */

/** A month's total below this carries into the next month's charge instead. */
export const USAGE_MIN_CHARGE_CENTS = 500;

/** Days a client has to pay a usage charge before it's overdue. */
export const USAGE_PAYMENT_TERMS_DAYS = 14;

/** First reminder goes out this many days before the due date. */
export const USAGE_REMINDER_DAYS_BEFORE = 3;

function monthKeyOf(year: number, monthIndex: number): string {
  const d = new Date(year, monthIndex, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" for the month before `d`. */
export function previousMonthKey(d: Date): string {
  return monthKeyOf(d.getFullYear(), d.getMonth() - 1);
}

/** The month before a "YYYY-MM" key. */
export function monthBefore(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return monthKeyOf(y, m - 2);
}

/** First instant of the month (local midnight). */
export function monthStart(key: string): Date {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1);
}

/** "YYYY-MM-DD" in server-local time, so reminders key off calendar days, not the second the job ran. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Month name and year. */
export function formatUsageMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}
