import "server-only";

import type { Contact } from "@/types/contacts";
import type { ScheduledMessageChannel } from "@/types/scheduled-messages";
import { prepareEmailSend, sendConversationEmail } from "./email";
import { prepareSmsSend, sendConversationSms } from "./sms";
import { prepareWhatsappSend, sendConversationWhatsapp } from "./whatsapp";
import { prepareMetaSend, sendConversationMeta } from "./meta";
import type { SendActor, SendOutcome, SendRefusal } from "./types";

export type { SendActor, SendOutcome, SendRefusal } from "./types";

/** Channels a conversation message can be sent (or scheduled) on. */
export type SendableChannel = ScheduledMessageChannel;

export interface ConversationMessageInput {
  channel: SendableChannel;
  contactId: string;
  contact: Contact;
  body: string;
  actor: SendActor;
  /** Email only. */
  subject?: string;
  inReplyTo?: string;
  references?: string[];
  /** WhatsApp only — see sendConversationWhatsapp. */
  humanReply?: boolean;
  idempotencyKey?: string;
}

/**
 * One conversation message, on any channel, through exactly the checks and
 * bookkeeping the manual send route for that channel runs. The routes call
 * their channel's function directly; the scheduled-message worker calls this.
 */
export async function sendConversationMessage(
  input: ConversationMessageInput
): Promise<SendOutcome> {
  const { channel, contactId, contact, body, actor } = input;
  switch (channel) {
    case "email":
      return sendConversationEmail({
        contactId,
        contact,
        body,
        actor,
        subject: input.subject ?? "",
        inReplyTo: input.inReplyTo,
        references: input.references,
      });
    case "sms":
      return sendConversationSms({ contactId, contact, body, actor });
    case "whatsapp":
      return sendConversationWhatsapp({
        contactId,
        contact,
        body,
        actor,
        humanReply: input.humanReply === true,
        idempotencyKey: input.idempotencyKey,
      });
    case "messenger":
    case "instagram":
      return sendConversationMeta({ contactId, contact, body, actor, channel });
  }
}

/**
 * The checks a send would refuse on right now, without sending — identity,
 * opt-out, agency gate, channel connected. Not the messaging windows: those
 * are decided when a message actually goes out. Used for early feedback when
 * a message is scheduled; the send re-runs every one of them at fire time.
 */
export async function precheckConversationMessage(
  channel: SendableChannel,
  contact: Contact
): Promise<SendRefusal | null> {
  const result =
    channel === "email"
      ? await prepareEmailSend(contact)
      : channel === "sms"
        ? await prepareSmsSend(contact)
        : channel === "whatsapp"
          ? await prepareWhatsappSend(contact)
          : await prepareMetaSend(contact, channel);
  return result.ok ? null : result;
}
