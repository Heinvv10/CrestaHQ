/**
 * Whether a caller-supplied value is a valid Firestore document id, by
 * Firestore's own rules — so it can never be a path: `contacts/${id}` with
 * "c1/scheduledMessages/s1" addresses a subcollection doc, which carries the
 * parent's subAccountId and so passes a tenant check. Rejected: empty, any
 * "/", exactly "." or "..", the reserved `__…__`, and over 1,500 UTF-8
 * bytes. Anything else (backslashes, spaces, unicode) is a real id that a
 * legacy doc may carry. Treat a failing id as "not found".
 */
export function isDocId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id) &&
    Buffer.byteLength(id, "utf8") <= 1500
  );
}
