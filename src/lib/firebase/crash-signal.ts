/**
 * The Firestore SDK fails its own async queue on an internal assertion
 * ("FIRESTORE (12.x) INTERNAL ASSERTION FAILED: Unexpected state (ID: ca9)",
 * then a stream of b815s). After that the instance is dead: no listener
 * fires again until the page reloads (firebase-js-sdk #9267, #10310). This
 * recognises that message in whatever shape it surfaces — an Error, an
 * unhandled rejection's reason, or a line from the SDK's logger — and
 * nothing else.
 */
const CRASH = /FIRESTORE \([^)]*\) INTERNAL ASSERTION FAILED/;

/** The crash message, or null when `value` is anything else. */
export function firestoreCrashMessage(value: unknown): string | null {
  const message =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : typeof (value as { message?: unknown } | null)?.message === "string"
          ? (value as { message: string }).message
          : null;
  return message !== null && CRASH.test(message) ? message : null;
}
