import type { ScheduledMessageChannel } from "@/types/scheduled-messages";

/**
 * Where a conversation message on a channel goes, from the stored contact:
 * shared by the agent send capabilities (to pin it) and the scheduled-message
 * worker (to refuse a pinned recipient that changed before firing).
 */
const FIELD: Record<ScheduledMessageChannel, "email" | "phone" | "metaUserId"> = {
  email: "email",
  sms: "phone",
  whatsapp: "phone",
  messenger: "metaUserId",
  instagram: "metaUserId",
};

/** The address a message on `channel` goes to, from the stored contact. */
export function recipientOf(channel: ScheduledMessageChannel, contact: Record<string, unknown>): string {
  const v = contact[FIELD[channel]];
  return typeof v === "string" ? v : "";
}

/** `contact` with the channel's address set to `to` (a pinned value). */
export function withRecipient<T extends Record<string, unknown>>(channel: ScheduledMessageChannel, contact: T, to: string): T {
  return { ...contact, [FIELD[channel]]: to };
}
