import "server-only";

/** Waits between the retries of the usage-overdue scans (250ms, then 750ms). Tests replace `sleep`. */
export const RETRY_BACKOFF_MS = [250, 750] as const;

export function backoffFor(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
