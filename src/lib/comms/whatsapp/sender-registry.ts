import { resolveWhatsAppProviderId } from "./provider";
import type { WhatsAppSender } from "@/types/whatsapp-senders";

/**
 * Pure write-side rules for the sender registry. The route owns the Firestore
 * read/write; everything that decides what a valid registry looks like lives
 * here so the two cannot drift.
 */

const MAX_LABEL = 60;
/** E.164: a plus, a non-zero country digit, then 6–14 more. */
const E164 = /^\+[1-9]\d{6,14}$/;

export interface SenderInput {
  label: string;
  provider: WhatsAppSender["provider"];
  phoneNumber: string;
  isDefault: boolean;
}

export function validateSenderInput(
  raw: unknown,
): { ok: true; value: SenderInput } | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return { ok: false, error: "Give the sender a label." };
  if (label.length > MAX_LABEL) {
    return { ok: false, error: `Labels are at most ${MAX_LABEL} characters.` };
  }
  const rawProvider = typeof body.provider === "string" ? body.provider : "";
  if (
    rawProvider !== "twilio" &&
    rawProvider !== "cloud" &&
    rawProvider !== "bridge"
  ) {
    return { ok: false, error: "Pick a rail: Twilio, Cloud or linked device." };
  }
  const phoneNumber =
    typeof body.phoneNumber === "string" ? body.phoneNumber.replace(/\s/g, "") : "";
  if (!E164.test(phoneNumber)) {
    return {
      ok: false,
      error: "Enter the number in international format, e.g. +27784356159.",
    };
  }
  return {
    ok: true,
    value: {
      label,
      provider: resolveWhatsAppProviderId(rawProvider),
      phoneNumber,
      isDefault: body.isDefault === true,
    },
  };
}

/**
 * Exactly one sender is the default — enforced here rather than trusted from
 * the client, because two defaults means the resolver picks by array order and
 * a step with no `senderId` silently changes number when the array is reordered.
 *
 * `preferredId` wins when it names a sender in the list. Otherwise the first
 * already-flagged sender keeps the flag, and with none flagged the first entry
 * takes it.
 */
export function withSingleDefault(
  senders: WhatsAppSender[],
  preferredId?: string,
): WhatsAppSender[] {
  if (senders.length === 0) return senders;
  const chosen =
    (preferredId && senders.find((s) => s.id === preferredId)) ||
    senders.find((s) => s.isDefault === true) ||
    senders[0];
  return senders.map((s) => ({ ...s, isDefault: s.id === chosen.id }));
}
