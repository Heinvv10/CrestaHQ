import "server-only";

import { buildTwilioClient } from "./twilio";

/**
 * Helpers for the dedicated-SMS setup flow:
 *
 *   - validateCredentials  — calls Twilio's /Accounts/{sid} to confirm the
 *     SID + token combo works. Returns { ok, error } so the settings UI can
 *     show a clear failure message.
 *
 *   - autoConfigureInboundWebhook — finds the IncomingPhoneNumber resource
 *     for the operator's `fromNumber` and updates its `smsUrl` + `smsMethod`
 *     to point at our /api/webhooks/twilio/inbound endpoint. Best-effort:
 *     failure is non-fatal (the UI surfaces a manual-config fallback with
 *     a copy-the-URL button).
 *
 * Both are designed to be called from the settings save route. Errors are
 * caught and turned into structured results — never thrown — because the
 * settings save shouldn't roll back if only the webhook step fails.
 */

export interface ValidateCredentialsResult {
  ok: boolean;
  /** Friendly account label from Twilio (used in success toasts). */
  friendlyName: string | null;
  error: string | null;
}

export async function validateCredentials(
  accountSid: string,
  authToken: string,
): Promise<ValidateCredentialsResult> {
  if (!accountSid || !authToken) {
    return { ok: false, friendlyName: null, error: "Missing SID or token." };
  }
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const account = await client.api.v2010.accounts(accountSid).fetch();
    return {
      ok: true,
      friendlyName: account.friendlyName ?? null,
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Twilio rejected the credentials.";
    return { ok: false, friendlyName: null, error: message };
  }
}

export interface AutoConfigureWebhookResult {
  ok: boolean;
  error: string | null;
}

/**
 * Finds the IncomingPhoneNumber resource that owns `fromNumber` and PATCHes
 * its smsUrl + smsMethod to point at our inbound endpoint.
 *
 * Twilio's IncomingPhoneNumbers list endpoint accepts `phoneNumber=` as a
 * query filter (E.164). It returns 0 or 1 results for a given number on a
 * given account.
 */
export async function autoConfigureInboundWebhook({
  accountSid,
  authToken,
  fromNumber,
  webhookUrl,
}: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  webhookUrl: string;
}): Promise<AutoConfigureWebhookResult> {
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1,
    });
    if (list.length === 0) {
      return {
        ok: false,
        error: `Twilio account doesn't own the number ${fromNumber}. Buy / port it first, or paste the number exactly as Twilio shows it (E.164, e.g. +15551234567).`,
      };
    }
    const phone = list[0];
    await client.incomingPhoneNumbers(phone.sid).update({
      smsUrl: webhookUrl,
      smsMethod: "POST",
    });
    return { ok: true, error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Twilio rejected the webhook configuration.";
    return { ok: false, error: message };
  }
}

export interface ConfigureVoiceWebhookResult {
  ok: boolean;
  error: string | null;
  /**
   * The Voice URL the number had BEFORE we overwrote it (null when it had
   * none). The caller persists this so a later disable can restore it instead
   * of clobbering an operator's manual forwarding. Undefined when the call
   * failed before it could read the number.
   */
  prevVoiceUrl?: string | null;
}

/**
 * Point the IncomingPhoneNumber's `voiceUrl` + `voiceMethod` at our Missed
 * Call Text Back handler. Reads and returns the current `voiceUrl` first so
 * the caller can restore it on disable — this is the ONLY place LeadStack
 * touches a number's Voice URL, and only ever on explicit opt-in. Best-effort:
 * failure is non-fatal and reported so the settings UI can offer a manual
 * fallback.
 */
export async function configureVoiceWebhook({
  accountSid,
  authToken,
  fromNumber,
  webhookUrl,
}: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  webhookUrl: string;
}): Promise<ConfigureVoiceWebhookResult> {
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1,
    });
    if (list.length === 0) {
      return {
        ok: false,
        error: `Twilio account doesn't own the number ${fromNumber}.`,
      };
    }
    const phone = list[0];
    // Capture the existing Voice URL so disable can restore it. Twilio returns
    // "" (not null) for an unset URL — normalise the empty case to null.
    const prevVoiceUrl = phone.voiceUrl ? phone.voiceUrl : null;
    await client.incomingPhoneNumbers(phone.sid).update({
      voiceUrl: webhookUrl,
      voiceMethod: "POST",
    });
    return { ok: true, error: null, prevVoiceUrl };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Twilio rejected the voice webhook configuration.";
    return { ok: false, error: message };
  }
}

/**
 * Restore (or clear) the number's `voiceUrl` when MCTB is disabled. Passing the
 * `prevVoiceUrl` we captured at enable time puts the number back exactly how we
 * found it; passing null clears it. Best-effort — a failure here doesn't block
 * the disable (the config flips off regardless; worst case the operator clears
 * the URL manually in Twilio).
 */
export async function restoreVoiceWebhook({
  accountSid,
  authToken,
  fromNumber,
  prevVoiceUrl,
}: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  prevVoiceUrl: string | null;
}): Promise<AutoConfigureWebhookResult> {
  try {
    const client = buildTwilioClient(accountSid, authToken);
    const list = await client.incomingPhoneNumbers.list({
      phoneNumber: fromNumber,
      limit: 1,
    });
    if (list.length === 0) {
      return { ok: false, error: `Twilio account doesn't own ${fromNumber}.` };
    }
    await client.incomingPhoneNumbers(list[0].sid).update({
      // Empty string clears the field on Twilio's side.
      voiceUrl: prevVoiceUrl ?? "",
      voiceMethod: "POST",
    });
    return { ok: true, error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Twilio rejected the voice webhook restore.";
    return { ok: false, error: message };
  }
}
