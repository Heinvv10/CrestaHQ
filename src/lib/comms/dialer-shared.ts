import type { TwilioConfig } from "@/types";

/**
 * Softphone v1 — the dialer rules the browser UI and the server both apply.
 * Pure and client-safe: no `server-only`, no SDK. The server stays the
 * authority on every one of them (docs/features/dialer.md); the UI uses them
 * to avoid offering what the server would refuse, and to decide what it may
 * turn into a link.
 */

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

/**
 * The RecordingUrl, only when it is exactly a recording on THIS sub-account's
 * own Twilio account at api.twilio.com: nothing before or after it, no other
 * account's SID, no other host, no query. Regional hosts (api.ie1.twilio.com …)
 * are not accepted. A missing or mis-shaped account SID, or a value that is not
 * a string, gives nothing. The ONE rule for both sinks: the status webhook
 * applies it before it stores the URL, and the timeline applies it again
 * before it links one — `meta.recordingUrl` on an activity row is untrusted
 * (members can write activity rows directly).
 */
export function ownRecordingUrl(raw: unknown, accountSid: unknown): string | null {
  if (typeof raw !== "string") return null;
  // The SID check is also what makes it safe to place in the pattern.
  if (typeof accountSid !== "string" || !ACCOUNT_SID.test(accountSid)) return null;
  const exact = new RegExp(
    `^https://api\\.twilio\\.com/2010-04-01/Accounts/${accountSid}/Recordings/RE[0-9a-f]{32}(\\.(mp3|wav))?$`,
  );
  return exact.test(raw) ? raw : null;
}

/**
 * Dedicated Twilio is on and complete, read from the member-readable
 * sub-account doc. Mirrors `subAccountTwilioIsConfigured` in the server-only
 * `twilio.ts` — `dialer-shared.test.ts` holds the two equal.
 */
export function dialerTwilioConfigured(
  cfg: TwilioConfig | null | undefined,
): boolean {
  return (
    !!cfg?.enabled &&
    !!cfg.accountSid &&
    (cfg.authTokenSet === true || !!cfg.authToken) &&
    !!cfg.fromNumber
  );
}

/**
 * "+", then only digits and the separators people type (space ( ) - . /),
 * at most 32 characters in all. Nothing else: no "tel:", no label, no letters,
 * no second "+", no invisible or full-width characters.
 */
const DIALABLE_FORM = /^\+[0-9 ()./-]{1,31}$/;

/**
 * The stored phone, trimmed, is written in strict "+…" international form.
 * The dialer's ONE rule for which stored strings may be dialled: the TwiML
 * webhook refuses anything else before it parses the number (libphonenumber
 * would otherwise pull "+27…" out of "tel:+27…" or "Mobile: +27…"), and the
 * Call button is disabled for anything else. Validity is still decided by the
 * webhook's parse.
 */
export function storedInInternationalForm(phone: unknown): boolean {
  return typeof phone === "string" && DIALABLE_FORM.test(phone.trim());
}
