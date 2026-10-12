import type { TwilioConfig } from "@/types";

/**
 * Softphone v1 — the dialer rules the browser UI and the server both apply.
 * Pure and client-safe: no `server-only`, no SDK. The server stays the
 * authority on every one of them (docs/features/dialer.md); the UI uses them
 * to avoid offering what the server would refuse, and to decide what it may
 * turn into a link.
 */

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;

/** The ONE shape of a Twilio recording URL. `account` is a regex fragment. */
function recordingPattern(account: string): RegExp {
  return new RegExp(
    `^https://api\\.twilio\\.com/2010-04-01/Accounts/${account}/Recordings/RE[0-9a-f]{32}(\\.(mp3|wav))?$`,
  );
}

const ANY_ACCOUNT_RECORDING = recordingPattern("AC[0-9a-f]{32}");

/**
 * Exactly a recording on SOME Twilio account at api.twilio.com: nothing before
 * or after it, no other host, no query. This is the check at the render sink —
 * `meta.recordingUrl` on an activity row is untrusted (members can write
 * activity rows directly), so the timeline links it only when this passes.
 */
export function isTwilioRecordingUrl(raw: unknown): raw is string {
  return typeof raw === "string" && ANY_ACCOUNT_RECORDING.test(raw);
}

/**
 * The RecordingUrl, only when it is exactly a recording on THIS sub-account's
 * own Twilio account at api.twilio.com: nothing before or after it, no other
 * account's SID, no other host. Regional hosts (api.ie1.twilio.com …) are not
 * accepted. A missing or mis-shaped account SID stores nothing. This is the
 * check the status webhook applies before it stores the URL.
 */
export function ownRecordingUrl(raw: string, accountSid: unknown): string | null {
  // The SID check is also what makes it safe to place in the pattern.
  if (typeof accountSid !== "string" || !ACCOUNT_SID.test(accountSid)) return null;
  return recordingPattern(accountSid).test(raw) ? raw : null;
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
 * The server dials only a number stored in "+…" international form (it parses
 * with no default region). This is the UI's hint for the Call button, not the
 * validity check: the TwiML webhook still parses and refuses.
 */
export function storedInInternationalForm(
  phone: string | null | undefined,
): boolean {
  return typeof phone === "string" && phone.trim().startsWith("+");
}
