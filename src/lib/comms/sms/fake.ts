import "server-only";

/**
 * Deterministic stand-in for Twilio's `messages.create`, reachable only
 * through `sendSmsVia` in select.ts — which refuses it outside loopback
 * dev/CI, outside a production build without the opt-in, and outside the
 * fixture agency (see mode.ts).
 *
 * Unlike the GBP/WhatsApp-settings fakes, there is no Firestore-backed
 * scenario store: no caller needs to script Twilio's behaviour beyond one
 * magic failing number, so the fake returns a deterministic sid and records
 * nothing else.
 */

/** Twilio's own "invalid"/undeliverable magic test number — never a real one. */
export const FAKE_SMS_FAIL_TO = "+15005550001";

let counter = 0;

export async function sendFakeSms(args: {
  to: string;
  body: string;
}): Promise<{ sid: string }> {
  if (args.to === FAKE_SMS_FAIL_TO) {
    throw new Error("fake SMS provider: send refused for the magic failing number");
  }
  counter += 1;
  return { sid: `SMfake${String(counter).padStart(8, "0")}` };
}
