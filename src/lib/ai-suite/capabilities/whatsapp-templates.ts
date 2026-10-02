import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { createWhatsappTemplateDraft, type TemplateDraftInput } from "@/lib/comms/whatsapp/template-create";
import { submitWhatsappTemplate } from "@/lib/comms/whatsapp/template-submit";
import { CapabilityUserError, type AiSuiteCapability, type ValidateResult } from "./types";
import { agentActor, str } from "./helpers";
import { agentText, hasUnsafeText, messageBody, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";

/**
 * Creating and submitting WhatsApp templates for API agents. The validation
 * and the writes are the human routes' own (template-create.ts /
 * template-submit.ts), so the two cannot drift. Both are direct writes: a
 * draft reaches nobody, and a submission reaches only Meta, which reviews it.
 * Every SEND of a template stays a proposal (send_whatsapp_template).
 *
 * A template body is later sent to people, so the body, labels, samples and
 * button text are refused when they carry anything a reader couldn't see.
 */

const DRAFT_KEYS = ["displayName", "category", "language", "body", "variables", "buttons"];
const VARIABLE_KEYS = ["position", "label", "sampleValue", "source", "mergeTag"];
const BUTTON_KEYS = ["type", "text", "url"];
/** Meta's locale codes: "en", "af", "en_US", "pt_BR". */
const LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

class ArgError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(obj).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new ArgError(`${where} has an unknown field ${JSON.stringify(oneLine(extra).slice(0, 40))}`);
}

/** Visible one-line text of at most `max` characters, refused rather than
 *  cut. `sent`: text a recipient reads (button text, links), held to the
 *  message-body rule, which also refuses a joiner between two letters. */
function visible(value: unknown, what: string, max: number, sent = false): string {
  if (typeof value !== "string") throw new ArgError(`${what} must be text`);
  const v = agentText(what, value);
  if (!v) throw new ArgError(`${what} is required`);
  if (hasUnsafeText(v) || (sent && messageBody(v) === null)) throw new ArgError(`${what} ${UNSAFE_TEXT_MESSAGE}`);
  if (v.length > max) throw new ArgError(`${what} must be at most ${max} characters`);
  return v;
}

function variableArgs(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) throw new ArgError("variables must be an array");
  return raw.map((v, i) => {
    const where = `variables[${i}]`;
    if (!isObject(v)) throw new ArgError(`${where} must be an object`);
    onlyKeys(v, VARIABLE_KEYS, where);
    if (!Number.isInteger(v.position) || (v.position as number) < 1) throw new ArgError(`${where}.position must be a whole number from 1`);
    const source = v.source ?? "manual";
    if (source !== "manual" && source !== "merge_tag") throw new ArgError(`${where}.source must be manual or merge_tag`);
    if (source === "manual" && v.mergeTag !== undefined) throw new ArgError(`${where} has a mergeTag, which needs source merge_tag`);
    return {
      position: v.position,
      ...(v.label !== undefined ? { label: visible(v.label, `${where}.label`, 80) } : {}),
      sampleValue: visible(v.sampleValue, `${where}.sampleValue`, 400),
      source,
      ...(source === "merge_tag" ? { mergeTag: visible(v.mergeTag, `${where}.mergeTag`, 200) } : {}),
    };
  });
}

function buttonArgs(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) throw new ArgError("buttons must be an array");
  return raw.map((b, i) => {
    const where = `buttons[${i}]`;
    if (!isObject(b)) throw new ArgError(`${where} must be an object`);
    onlyKeys(b, BUTTON_KEYS, where);
    const text = visible(b.text, `${where}.text`, 25, true);
    if (b.type === "quick_reply") {
      if (b.url !== undefined) throw new ArgError(`${where} is a quick reply, which has no url`);
      return { type: "quick_reply", text };
    }
    if (b.type === "url") return { type: "url", text, url: visible(b.url, `${where}.url`, 2000, true) };
    throw new ArgError(`${where}.type must be quick_reply or url`);
  });
}

/** The draft as create_whatsapp_template stores it, before the shared
 *  validation (numbering, merge tags, button rules) runs at execute. */
function draftArgs(raw: unknown): ValidateResult {
  try {
    if (!isObject(raw)) throw new ArgError("the arguments must be an object");
    onlyKeys(raw, DRAFT_KEYS, "the template");
    const displayName = visible(raw.displayName, "displayName", 120);
    if (raw.category !== "UTILITY" && raw.category !== "MARKETING") throw new ArgError("category must be UTILITY or MARKETING");
    const language = raw.language === undefined ? "en" : visible(raw.language, "language", 12);
    if (!LANGUAGE_RE.test(language)) throw new ArgError("language must be a WhatsApp locale code such as en, af or en_US");
    if (typeof raw.body !== "string") throw new ArgError("body must be text");
    const body = messageBody(raw.body);
    if (body === null) throw new ArgError(`body ${UNSAFE_TEXT_MESSAGE}`);
    if (!body) throw new ArgError("body is required");
    if (body.length > 1024) throw new ArgError("body must be at most 1024 characters");
    return {
      ok: true,
      args: {
        displayName,
        category: raw.category,
        language,
        body,
        variables: raw.variables === undefined ? [] : variableArgs(raw.variables),
        buttons: raw.buttons === undefined ? [] : buttonArgs(raw.buttons),
      },
    };
  } catch (err) {
    if (err instanceof ArgError) return { ok: false, error: err.message };
    throw err;
  }
}

const VARIABLE_SCHEMA = {
  type: "object",
  properties: {
    position: { type: "integer", minimum: 1, description: "The n of {{n}} in the body." },
    label: { type: "string", description: "What the value is, e.g. First name." },
    sampleValue: { type: "string", description: "An example value; Meta reviews the template with it." },
    source: { type: "string", enum: ["manual", "merge_tag"], description: "manual: given at send time. merge_tag: filled from the contact." },
    mergeTag: { type: "string", description: "With source merge_tag, e.g. contact.firstName." },
  },
  required: ["position", "sampleValue"],
  additionalProperties: false,
};
const BUTTON_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["quick_reply", "url"] },
    text: { type: "string", description: "1–25 characters." },
    url: { type: "string", description: "url buttons only: a fixed https:// link." },
  },
  required: ["type", "text"],
  additionalProperties: false,
};

export const WHATSAPP_TEMPLATE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "create_whatsapp_template",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Draft a WhatsApp message template",
    description:
      "Create a DRAFT WhatsApp template. It reaches nobody until submit_whatsapp_template sends it to Meta for review. " +
      "Placeholders are {{1}}, {{2}}… numbered from 1, each with one variables entry carrying a sampleValue. " +
      "Up to 3 buttons: quick replies and/or up to 2 https links.",
    parameters: {
      type: "object",
      properties: {
        displayName: { type: "string", description: "Its name in the app; Meta's template name is derived from it." },
        category: { type: "string", enum: ["UTILITY", "MARKETING"] },
        language: { type: "string", description: "Locale code, default en." },
        body: { type: "string", description: "At most 1024 characters." },
        variables: { type: "array", items: VARIABLE_SCHEMA },
        buttons: { type: "array", items: BUTTON_SCHEMA },
      },
      required: ["displayName", "category", "body"],
      additionalProperties: false,
    },
    validate: draftArgs,
    summarize: (args) => `Draft the WhatsApp template “${args.displayName}”.`,
    execute: async (ctx, args) => {
      const created = await createWhatsappTemplateDraft({
        subAccountId: ctx.subAccountId!,
        input: args as TemplateDraftInput,
        createdByUid: ctx.uid,
        stamp: agentEditStamp(agentActor(ctx, "create_whatsapp_template")),
      });
      if (!created.ok) throw new CapabilityUserError(created.error);
      return {
        resultText: `Created the draft template (id: ${created.id}). Submit it with submit_whatsapp_template to send it to Meta for review.`,
        ref: { kind: "whatsappTemplate", id: created.id },
      };
    },
  },
  {
    name: "submit_whatsapp_template",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Submit a WhatsApp template to Meta for review",
    description:
      "Submit a draft, rejected or failed WhatsApp template to Meta for review, on the WhatsApp rail this workspace sends on. " +
      "It reaches no person: Meta reviews it, and list_whatsapp_templates shows the outcome. Sending it still needs approval (send_whatsapp_template).",
    parameters: {
      type: "object",
      properties: { templateId: { type: "string", description: "The template's id (from list_whatsapp_templates)." } },
      required: ["templateId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      if (!isObject(raw)) return { ok: false, error: "the arguments must be an object" };
      try {
        onlyKeys(raw, ["templateId"], "the call");
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      const templateId = str(raw, "templateId");
      return isDocId(templateId) ? { ok: true, args: { templateId } } : { ok: false, error: "a templateId is required" };
    },
    summarize: (args) => `Submit the WhatsApp template ${args.templateId} to Meta for review.`,
    execute: async (ctx, args) => {
      const r = await submitWhatsappTemplate(ctx.subAccountId!, args.templateId as string);
      if (!r.ok) throw new CapabilityUserError(r.error);
      const ref = { kind: "whatsappTemplate", id: args.templateId as string };
      const submitted = `Submitted “${r.name}” to Meta for review on the ${r.provider} rail`;
      if (r.pollQueued === false) {
        return { resultText: `${submitted}, but its approval check could not be scheduled, so it is marked failed. Submit it again to retry.`, ref };
      }
      if (r.pollQueued === null) {
        return { resultText: `${submitted}. It is pending; its approval status won't update here automatically (scheduling isn't configured).`, ref };
      }
      return { resultText: `${submitted}. It is pending until Meta decides; list_whatsapp_templates shows the outcome.`, ref };
    },
  },
];
