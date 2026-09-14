/**
 * Did a send reach a provider before it failed? (SP5 d1.) The error is marked
 * where the carrier call happens — the SMS seam, Twilio's messages.create,
 * the SMTP and Resend sends — so a caller's catch can tell a provider failure
 * from a refusal decided before sending. A review ask is logged as failed
 * only in the first case.
 */

const ATTEMPTED = Symbol.for("leadstack.providerAttempted");

/** Marks and returns the same error; a non-object or frozen value is left as is. */
export function markProviderAttempted<T>(err: T): T {
  if (typeof err === "object" && err !== null && Object.isExtensible(err)) {
    Object.defineProperty(err, ATTEMPTED, { value: true });
  }
  return err;
}

/** For `.catch(rethrowAttempted)` on a provider call. */
export function rethrowAttempted(err: unknown): never {
  throw markProviderAttempted(err);
}

export function providerAttempted(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[ATTEMPTED] === true;
}
