import "server-only";

import { emailIsConfigured, sendEmail } from "@/lib/comms/resend";
import { isEmailSuppressedError } from "@/lib/comms/email-suppression";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import { checkOutboundCompliance } from "@/lib/comms/voice/outbound-compliance";
import { outboundVoiceReady, placeContactCall } from "@/lib/server/voice-call";
import { vapiAppUrlConfigured } from "@/lib/comms/voice/vapi";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { MysteryShopChannel } from "./model";
import { normalizeEmailTarget } from "./targets";
import { sendWhatsappShop, whatsappState, type WhatsappEnquiry } from "./whatsapp";
import { formChannelState } from "./form/target";

/**
 * Sending a mystery shop over the existing comms rails — never a hand-rolled
 * provider call. Email goes through `sendEmail` with the sub-account's own
 * SMTP and is archived to Conversations (its Message-ID is the shop's
 * `providerRef`). A call goes through the native outbound gate with the
 * operator's per-send consent, then `placeContactCall` (its caps placeholder,
 * activity row and contact stamp), as a short capped call carrying the shop id.
 * WhatsApp is an approved template through the composer's own service
 * (whatsapp.ts); its message id is the `providerRef`.
 * A website form is not sent here: the route queues its job (form/job.ts).
 */

export type ChannelState = { available: boolean; reason?: string };

/** The synced mailbox's own address: the Reply-To, so the business's reply lands where it is read. */
const mailboxAddress = (sub: SubAccountDoc) => normalizeEmailTarget(sub.mailboxConfig?.username);

/**
 * Whether each channel can send for this sub-account right now. Email needs a
 * verified SMTP sender AND a working IMAP mailbox whose address is known and
 * is that sender's (it is the Reply-To, and bounces return to the sender):
 * a reply or bounce that lands in a mailbox we do not read is never seen.
 */
export async function channelStates(
  subAccountId: string,
  sub: SubAccountDoc,
): Promise<Record<MysteryShopChannel, ChannelState>> {
  const mailbox = sub.mailboxConfig;
  const email: ChannelState =
    sub.emailProvider !== "smtp" || !emailIsConfigured(sub)
      ? { available: false, reason: "Connect and verify your own SMTP email in Messaging settings first." }
      : !mailbox?.enabled || !mailbox.verifiedAt
        ? { available: false, reason: "Connect your IMAP mailbox in Messaging settings first, so replies can be timed." }
        : mailbox.lastError
          ? { available: false, reason: `The mailbox sync is failing: ${mailbox.lastError}` }
          : !mailboxAddress(sub)
            ? { available: false, reason: "The mailbox address isn't known." }
            : mailboxAddress(sub) !== normalizeEmailTarget(sub.smtpConfig?.fromEmail)
              ? { available: false, reason: "Mystery-shop email needs the SMTP sender and the synced mailbox to be the same address." }
              : { available: true };
  const voice = await outboundVoiceReady(subAccountId);
  // The public URL Vapi calls back: checked here so a misconfiguration shows as unavailable, never as an uncertain send.
  const call: ChannelState = !voice.ok
    ? { available: false, reason: voice.error }
    : !vapiAppUrlConfigured()
      ? { available: false, reason: "Voice calling needs the app's public URL (VAPI_PUBLIC_BASE_URL or NEXT_PUBLIC_APP_URL)." }
      : { available: true };
  return { email, call, whatsapp: await whatsappState(subAccountId, sub), form: formChannelState(sub) };
}

/**
 * `failed` = the provider definitely did not take it (refused before the
 * call, or rejected it); `uncertain` = it may have gone out (an error after
 * the provider was asked — the repo's provider-attempt convention for email,
 * a network error or a Vapi 5xx for a call, an ambiguous Meta answer for
 * WhatsApp).
 */
export type SendResult =
  | { ok: true; providerRef: string }
  | { ok: false; kind: "refused"; code: string; reason: string }
  | { ok: false; kind: "failed"; reason: string }
  | { ok: false; kind: "uncertain"; providerRef: string | null; reason: string };

export async function sendMysteryShop(input: {
  shopId: string;
  channel: MysteryShopChannel;
  target: string;
  subAccountId: string;
  sub: SubAccountDoc;
  contact: Contact;
  contactId: string;
  uid: string;
  enquiry: { email: { subject: string; body: string }; call: string; whatsapp?: WhatsappEnquiry | null };
  /** The operator's per-call consent, as the confirm dialog sent it. */
  consentAck: boolean;
}): Promise<SendResult> {
  const { channel, target, subAccountId, contact } = input;
  if (channel === "email") {
    if (contact.emailOptedOut === true) {
      return { ok: false, kind: "refused", code: "opted_out", reason: "This contact has opted out of email." };
    }
    const replyTo = mailboxAddress(input.sub);
    if (!replyTo) return { ok: false, kind: "refused", code: "channel_unavailable", reason: "The mailbox address isn't known." };
    try {
      const sent = await sendEmail({
        to: target,
        subject: input.enquiry.email.subject,
        text: input.enquiry.email.body,
        subAccount: input.sub,
        // Metered like other tenant sends; it also scopes the SMTP mailbox and the suppression list.
        meter: { subAccountId },
        replyTo,
        archive: true,
        contactId: input.contactId,
        sentByUid: input.uid,
      });
      return { ok: true, providerRef: sent.id };
    } catch (err) {
      if (isEmailSuppressedError(err)) return { ok: false, kind: "refused", code: err.code, reason: err.message };
      const reason = err instanceof Error ? err.message : "The email could not be sent.";
      return providerAttempted(err) ? { ok: false, kind: "uncertain", providerRef: null, reason } : { ok: false, kind: "failed", reason };
    }
  }
  if (channel === "call") {
    const ready = await outboundVoiceReady(subAccountId);
    if (!ready.ok) return { ok: false, kind: "refused", code: "channel_unavailable", reason: ready.error };
    // The gate checks the number being dialled, which is the confirmed target.
    const compliance = await checkOutboundCompliance({
      subAccountId,
      contact: { ...contact, phone: target },
      voice: ready.voice,
      agentTimezone: ready.agentTimezone,
      consentAck: input.consentAck,
    });
    if (!compliance.allowed) {
      return {
        ok: false,
        kind: "refused",
        code: compliance.code ?? "refused",
        reason: compliance.reason ?? "This call is not allowed right now.",
      };
    }
    const placed = await placeContactCall({
      contact,
      contactId: input.contactId,
      uid: input.uid,
      voice: ready.voice,
      customerNumber: compliance.e164 ?? target,
      mysteryShop: { id: input.shopId, firstMessage: input.enquiry.call, maxDurationSeconds: 120 },
    });
    if (placed.ok) return { ok: true, providerRef: placed.callId };
    return placed.uncertain
      ? { ok: false, kind: "uncertain", providerRef: null, reason: placed.error }
      : { ok: false, kind: "failed", reason: placed.error };
  }
  if (channel === "whatsapp") {
    return sendWhatsappShop({
      shopId: input.shopId, target, contact, contactId: input.contactId, uid: input.uid, enquiry: input.enquiry.whatsapp,
    });
  }
  return { ok: false, kind: "refused", code: "channel_unavailable", reason: "Not available yet." };
}
