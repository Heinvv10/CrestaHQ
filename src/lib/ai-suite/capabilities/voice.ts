import "server-only";

import { parsePhoneNumberFromString } from "libphonenumber-js";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { checkOutboundCompliance } from "@/lib/comms/voice/outbound-compliance";
import { outboundVoiceReady, placeContactCall } from "@/lib/server/voice-call";
import { createHash } from "node:crypto";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { voiceCallPrompt } from "@/lib/comms/voice/call-prompt";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { messageBody, oneLine, plainSpaces } from "./text-safety";
import { masked } from "./conversation-send-support";
import { voiceSenderNumber } from "./sender-number";

/**
 * start_voice_call for API agents (AGENT_API_V1_PLAN.md, PR13): the Voice
 * channel's AI assistant rings a contact, as the contact card's Call button
 * does, once a person approves (outbound; it also spends voice minutes). The
 * preview shows the number, the assistant and calling number, exactly what
 * the AI says first and the script it runs on (call-prompt.ts, as the
 * custom-LLM webhook builds it), all pinned (the script by fingerprint). Approving is the per-call consent
 * acknowledgment; at dial time the call's own compliance gate (opt-out, the
 * calling window, daily and per-number caps, quota) runs, and a changed
 * number, assistant or opening line refuses the call.
 */

async function plan(subAccountId: string, contactId: unknown) {
  const snap = isDocId(contactId) ? await getAdminDb().doc(`contacts/${contactId}`).get() : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That contact isn't in this workspace.");
  const contact = { ...(data as Omit<Contact, "id">), id: snap!.id } as Contact;
  const ready = await outboundVoiceReady(subAccountId);
  if (!ready.ok) throw new CapabilityUserError(ready.error);
  const parsed = contact.phone ? parsePhoneNumberFromString(contact.phone) : null;
  if (!parsed?.isValid()) throw new CapabilityUserError("This contact has no valid phone number.");
  if (contact.voiceOptedOut === true) throw new CapabilityUserError("This contact has opted out of voice calls.");
  const firstMessage = ready.voice.outboundFirstMessage ?? "";
  if (messageBody(firstMessage) !== plainSpaces(firstMessage)) throw new CapabilityUserError("The opening line has characters or spacing that can't be shown exactly.");
  // The script the AI runs on for this call, as the custom-LLM webhook builds it each turn.
  const agent = await resolveAgent(subAccountId, "voice");
  if (!agent?.effective.systemPrompt.trim()) throw new CapabilityUserError("The Voice channel has no persona configured.");
  const subAccount = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() as SubAccountDoc;
  const built = await voiceCallPrompt({ subAccountId, agent, subAccount, callerPhone: parsed.number as string, outbound: true, contactId: contact.id });
  const persona = built.outboundPersona ?? agent.effective.systemPrompt.trim();
  if (messageBody(persona) !== plainSpaces(persona)) throw new CapabilityUserError("The call's persona has characters or spacing that can't be shown exactly.");
  return {
    contact,
    ready,
    persona,
    greets: built.contact?.name?.trim().split(/\s+/)[0] ?? null,
    pinned: {
      contactId: contact.id,
      number: parsed.number as string,
      assistantId: ready.voice.vapiAssistantId,
      phoneNumberId: ready.voice.vapiPhoneNumberId,
      from: voiceSenderNumber(subAccount, ready.voice),
      firstMessage,
      promptFingerprint: createHash("sha256").update(built.systemPrompt).digest("hex"),
    },
  };
}

export const VOICE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "start_voice_call",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Have the AI voice assistant call a contact (a person approves)",
    description:
      "Have the Voice channel's AI assistant phone a contact now, as the contact card's Call button does. Queued for a person to approve; the approver confirms consent.",
    parameters: { type: "object", properties: { contactId: { type: "string", description: "The contact's id (from find_contacts)." } }, required: ["contactId"], additionalProperties: false },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      return isDocId(contactId) ? { ok: true, args: { contactId } } : { ok: false, error: "a contactId is required" };
    },
    summarize: () => "Call a contact with the AI assistant.",
    approvalTarget: async (ctx, args) => {
      const { contact } = await plan(ctx.subAccountId!, args.contactId);
      return { contactId: contact.id, territoryId: null, scoped: true };
    },
    preview: async (ctx, args) => {
      const { contact, pinned, persona, greets } = await plan(ctx.subAccountId!, args.contactId);
      return {
        rows: [
          { label: "Call", value: `${oneLine(contact.name) || "(unnamed)"} (${masked("sms", pinned.number)})` },
          { label: "Assistant", value: `the Voice channel's AI assistant (${pinned.assistantId}), from its calling number (${pinned.phoneNumberId})` },
          { label: "From", value: pinned.from },
          { label: "First words", value: messageBody(pinned.firstMessage) || "(the assistant's default greeting)", multiline: true },
          { label: "Script (what the AI is told)", value: messageBody(persona)!, multiline: true },
          { label: "Greets them as", value: greets ? oneLine(greets) : "(no name)" },
          { label: "Consent", value: "Approving confirms you have this contact's consent to be called." },
          { label: "At dial time", value: "The calling window, daily and per-number caps and the voice-minutes quota are checked; a blocked call isn't placed." },
          { label: "Cost", value: "Uses voice minutes." },
        ],
        pinned,
      };
    },
    execute: async (ctx, args) => {
      const pinned = ctx.approved?.pinned ?? {};
      if (!ctx.approved) throw new CapabilityUserError("A call needs a person's approval.");
      const { contact, ready, pinned: now } = await plan(ctx.subAccountId!, args.contactId);
      const keys = ["contactId", "number", "assistantId", "phoneNumberId", "from", "firstMessage", "promptFingerprint"] as const;
      if (keys.some((k) => now[k] !== pinned[k])) {
        throw new CapabilityUserError("The number, the assistant, its calling number, its opening line or its script changed since this was reviewed; no call was placed.");
      }
      const compliance = await checkOutboundCompliance({ subAccountId: ctx.subAccountId!, contact, voice: ready.voice, agentTimezone: ready.agentTimezone, consentAck: true });
      if (!compliance.allowed) throw new CapabilityUserError(`The call wasn't placed: ${compliance.reason}`);
      const placed = await placeContactCall({ contact, contactId: contact.id, uid: ctx.uid, voice: ready.voice, customerNumber: now.number });
      // A provider error can't say whether the phone rang.
      if (!placed.ok) throw new CapabilityOutcomeUnknown(`The call may not have been placed: ${placed.error}`);
      return { resultText: `Placed the call (id: ${placed.callId}).`, ref: { kind: "voiceCall", id: placed.callId } };
    },
  },
];
