import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import type { ResolvedAiAgent } from "@/types/ai";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * The system prompt a voice call runs on, built exactly as the custom-LLM
 * webhook builds it each turn: shared by that webhook and the agent's
 * start_voice_call, whose approver sees the persona and whose approval pins
 * this prompt.
 */

async function findContactByPhone(
  subAccountId: string,
  phone: string,
): Promise<Contact | null> {
  const snap = await getAdminDb()
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("phone", "==", phone)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<Contact, "id">) };
}

/**
 * Voice-only, minimal contact context. Caller ID is trivially spoofable
 * (inbound) and an outbound call can be answered by anyone who picks up
 * the dialed handset — neither case is a verified identity. So unlike
 * SMS / web-chat's buildContactContextBlock(), the voice agent is NEVER
 * handed company name, deals, account status, or any other account
 * detail from the matched contact — only a first name, explicitly
 * flagged as unconfirmed, for a natural greeting. Anything else about
 * the account requires the caller to state it themselves, or must wait
 * for the operator's own verification step.
 */
function buildVoiceCallerNameBlock(contact: Contact | null): string | null {
  const firstName = contact?.name?.trim().split(/\s+/)[0];
  if (!firstName) return null;
  return `## Caller (from caller ID — a name match only, NOT a verified identity)
Their name may be ${firstName}. You may use this to greet them naturally (e.g. "Hi, is this ${firstName}?"). Do NOT mention their company, deals, account status, bookings, or any other detail about their account — you have no way to confirm this caller is who the phone number suggests. Only discuss account-specific details the caller themselves states on the call, or after a human has verified their identity.`;
}

/** The contact an outbound call was placed to, when it is this sub-account's. */
async function calledContact(subAccountId: string, contactId: string): Promise<Contact | null> {
  if (contactId.includes("/")) return null;
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  const data = snap.data();
  return data && data.subAccountId === subAccountId ? { id: snap.id, ...(data as Omit<Contact, "id">) } : null;
}

/**
 * Outbound calls run a different persona than inbound (the AI is calling the
 * contact about an offer, not answering a query): the outbound persona when
 * one is configured, else the shared one. `outboundPersona` is null when the
 * shared persona is used; `contact` is the caller-ID match the prompt greets.
 */
export async function voiceCallPrompt(opts: {
  subAccountId: string;
  agent: ResolvedAiAgent;
  subAccount: SubAccountDoc;
  callerPhone: string;
  outbound: boolean;
  /** An outbound call's own contact (the call metadata's contactId): used instead of
   *  a phone lookup, which can match another contact sharing the number. */
  contactId?: string | null;
}): Promise<{ systemPrompt: string; outboundPersona: string | null; contact: Contact | null }> {
  const contact =
    opts.outbound && opts.contactId
      ? await calledContact(opts.subAccountId, opts.contactId).catch(() => null)
      : opts.callerPhone
        ? await findContactByPhone(opts.subAccountId, opts.callerPhone).catch(() => null)
        : null;
  const outboundPersona = (opts.outbound && opts.agent.channel.voice?.outboundSystemPrompt?.trim()) || null;
  const systemPrompt = buildSystemPrompt({
    agent: opts.agent,
    channelId: "voice",
    fallbackBusinessName: opts.subAccount.name ?? "the business",
    contactContextBlock: buildVoiceCallerNameBlock(contact),
    personaOverride: outboundPersona,
    bookingLink: opts.subAccount.bookingLink ?? null,
  });
  return { systemPrompt, outboundPersona, contact };
}
