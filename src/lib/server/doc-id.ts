/**
 * Whether a caller-supplied value is safe to use as ONE Firestore document
 * id. Anything else — above all a value with "/" — must never be put into a
 * path: `contacts/${"c1/scheduledMessages/s1"}` addresses a subcollection
 * doc, which carries the parent's subAccountId and so passes a tenant check.
 * Treat a failing id as "not found".
 */
export function isDocId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
