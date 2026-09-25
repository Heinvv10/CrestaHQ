import "server-only";

import { createHash } from "node:crypto";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import { isTemplateApprovedFor, templateRegistration } from "@/lib/comms/whatsapp/template-registrations";
import { isDocId } from "@/lib/server/doc-id";
import {
  prepareWhatsappTemplateSend,
  renderPreview,
  sendWhatsappTemplate,
  type PreparedTemplateSend,
} from "@/lib/server/whatsapp-template-send";
import type { Contact } from "@/types/contacts";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability, type PreviewRow } from "./types";
import { str } from "./helpers";
import { hasUnsafeText, messageBody, plainSpaces, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { conversationIdParam } from "./conversations-read";
import { resolveContact } from "./conversation-send-support";
import { approvedRecipient, outgoingApprovalTarget, outgoingPreview } from "./outgoing-message";

/**
 * send_whatsapp_template for API agents (AGENT_API_V1_PLAN.md, PR8d): an
 * approved WhatsApp template, the one message that may go out after the
 * 24-hour reply window has closed. Always a proposal: the approver sees the
 * template, its language and the text exactly as the contact will read it,
 * variables filled in. The recipient AND what was rendered are pinned; the
 * send goes through the composer's own service (lib/server/whatsapp-template-send)
 * as the approver.
 */

// Meta refuses template parameters with line breaks, tabs or more than four
// spaces in a row, and template body text over 1024 characters.
const MAX_TEXT = 1024;
const RUN_OF_SPACES = / {5,}/;

/** Why a variable value can't be sent, or null. Line breaks are refused (Cc). */
function valueProblem(v: string): string | null {
  if (hasUnsafeText(v)) return "can't contain line breaks, tabs or invisible characters";
  // Any space character counts (a run of no-break spaces too).
  if (RUN_OF_SPACES.test(plainSpaces(v))) return "can't contain more than 4 spaces in a row";
  if (v.length > MAX_TEXT) return `must be at most ${MAX_TEXT} characters`;
  return null;
}

/**
 * One hash of what the approver saw: the template and the filled-in values,
 * plus the rail and the provider's own template id, since what the provider
 * sends is ITS stored copy of the template.
 */
function renderedPin(templateId: string, { subAccount, tpl, values }: PreparedTemplateSend): string {
  const sender = resolveWhatsappSender(subAccount);
  const provider = sender.ok ? sender.provider : null;
  const externalId = provider ? (templateRegistration(tpl, provider)?.externalId ?? null) : null;
  return createHash("sha256")
    .update(JSON.stringify([templateId, provider, externalId, tpl.name, tpl.language, tpl.body, tpl.buttons ?? [], values]))
    .digest("hex");
}

async function prepared(contact: Contact, args: Record<string, unknown>): Promise<PreparedTemplateSend> {
  const r = await prepareWhatsappTemplateSend(contact, args.templateId as string, args.variables as Record<string, string>);
  if (!r.ok) throw new CapabilityUserError(r.error);
  return { subAccount: r.subAccount, tpl: r.tpl, values: r.values };
}

function buttonsSummary(tpl: WhatsappTemplateDoc): PreviewRow[] {
  if (!tpl.buttons?.length) return [];
  const parts = tpl.buttons.map((b) => (b.type === "url" ? `link "${b.text}" (${b.url})` : `quick reply "${b.text}"`));
  return [{ label: "Buttons", value: parts.join(" · ") }];
}

export const CONVERSATION_WA_TEMPLATE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "send_whatsapp_template",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Send an approved WhatsApp template in a conversation (a person approves)",
    description:
      "Send one of the sub-account's approved WhatsApp templates to a conversation's contact; the only WhatsApp message allowed after the contact's 24-hour reply window has closed. Merge-tag variables fill themselves; give `variables` for the manual ones, keyed by position (\"1\", \"2\", …), one line each. Queued for a person to approve; it goes to the number they reviewed.",
    parameters: {
      type: "object",
      properties: {
        conversationId: conversationIdParam,
        templateId: { type: "string", description: "The WhatsApp template's id." },
        variables: {
          type: "object",
          description: "Values for the template's variables by position, e.g. {\"2\": \"Tuesday 10:00\"}. One line each.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["conversationId", "templateId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const conversationId = str(raw, "conversationId");
      const templateId = str(raw, "templateId");
      if (!conversationId) return { ok: false, error: "a conversationId is required" };
      if (!isDocId(templateId)) return { ok: false, error: "a templateId is required" };
      const given = r.variables ?? {};
      if (typeof given !== "object" || given === null || Array.isArray(given)) {
        return { ok: false, error: "variables must be an object of position → text" };
      }
      const variables: Record<string, string> = {};
      for (const [pos, v] of Object.entries(given)) {
        if (!/^[1-9]\d?$/.test(pos)) return { ok: false, error: `variable "${pos}" isn't a position (1, 2, …)` };
        const value = typeof v === "string" ? messageBody(v) : null;
        const problem = value === null ? UNSAFE_TEXT_MESSAGE : valueProblem(value);
        if (problem) return { ok: false, error: `variable ${pos} ${problem}` };
        variables[pos] = value!;
      }
      // channel: the shared pin and consent checks read it.
      return { ok: true, args: { conversationId, channel: "whatsapp", templateId, variables } };
    },
    summarize: (args) => `Send the WhatsApp template ${args.templateId}.`,
    approvalTarget: outgoingApprovalTarget,
    preview: async (ctx, args) => {
      const { contactId, contact } = await resolveContact(ctx.subAccountId!, args.conversationId);
      // Consent is its own preview row (and refused at propose and approve):
      // an opt-out after the proposal must change the preview, not break it.
      const ready = await prepared({ ...contact, id: contactId, whatsappOptedOut: false } as Contact, args);
      const { subAccount, tpl, values } = ready;
      const sender = resolveWhatsappSender(subAccount);
      if (!sender.ok) throw new CapabilityUserError(sender.error);
      // The bridge never holds an approved registration, so it is refused here too.
      if (!isTemplateApprovedFor(tpl, sender.provider)) {
        throw new CapabilityUserError(`Template "${tpl.name}" isn't approved for sending on this workspace's WhatsApp account.`);
      }
      tpl.variables.forEach((v, i) => {
        const problem = valueProblem(values[i] ?? "");
        if (problem) throw new CapabilityUserError(`The "${v.label}" value ${problem}.`);
      });
      // A placeholder with no value would be filled by the provider (Twilio
      // falls back to the sample), never by what the approver read.
      for (const [, n] of tpl.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
        if (!values[Number(n) - 1]) throw new CapabilityUserError(`The template's text uses {{${n}}}, which has no variable to fill it.`);
      }
      const rendered = renderPreview(tpl.body, values);
      if (rendered.length > MAX_TEXT) throw new CapabilityUserError(`The filled-in template must be at most ${MAX_TEXT} characters.`);
      const shown = messageBody(rendered);
      if (shown === null) throw new CapabilityUserError(`The template's text ${UNSAFE_TEXT_MESSAGE}`);
      // The Message row must be what is dispatched. The agent's own values are
      // normalised already, so this trips only on stored text (a template or a
      // merge-tag value with odd spacing, e.g. U+1680, which renders as a dash).
      if (shown !== rendered) {
        throw new CapabilityUserError("The filled-in template has spacing or characters that would not show exactly as sent.");
      }
      const base = await outgoingPreview(ctx, { ...args, channel: "whatsapp", body: shown }, [
        { label: "Template", value: `${tpl.displayName} (${tpl.name})` },
        { label: "Language", value: tpl.language },
        {
          label: "When",
          value: "Sends immediately when approved (quiet hours don't hold it). WhatsApp's 24-hour reply window doesn't apply to templates.",
        },
      ]);
      return {
        rows: [...base.rows, ...buttonsSummary(tpl)],
        pinned: { ...base.pinned, templateId: args.templateId, rendered: renderedPin(args.templateId as string, ready) },
      };
    },
    execute: async (ctx, args) => {
      const { contactId, sendTo, pinned } = await approvedRecipient(ctx, ctx.subAccountId!, args, "send_whatsapp_template");
      const ready = await prepared(sendTo, args);
      if (pinned.templateId !== args.templateId || renderedPin(args.templateId as string, ready) !== pinned.rendered) {
        throw new CapabilityUserError("The template or its values changed since this was reviewed; nothing was sent.");
      }
      let sent: Awaited<ReturnType<typeof sendWhatsappTemplate>>;
      try {
        sent = await sendWhatsappTemplate({ ...ready, contactId, contact: sendTo, templateId: args.templateId as string, actorUid: ctx.uid });
      } catch (err) {
        // A throw may come after the provider accepted it: never "failed".
        console.error("[send_whatsapp_template] the send threw", err);
        throw new CapabilityOutcomeUnknown(
          "The template may have gone out: something failed during the send. Check the thread before sending again."
        );
      }
      if (!sent.ok) {
        // Once the provider was contacted, even a rejection may have gone out.
        if (sent.status === 502 || sent.attempted) throw new CapabilityOutcomeUnknown(sent.error);
        throw new CapabilityUserError(sent.error);
      }
      return { resultText: "Sent the WhatsApp template.", ref: { kind: "message", id: sent.sid } };
    },
  },
];
