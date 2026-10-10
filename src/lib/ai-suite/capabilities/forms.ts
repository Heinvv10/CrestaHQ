import "server-only";

import {
  createFormServerSide,
  formEmbedSnippet,
  formPublicUrl,
  FormServiceError,
  listFormsForSubAccount,
} from "@/lib/server/forms-service";
import type { FormTemplate } from "@/types/forms";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";

/**
 * Lead forms for the Speed-to-Lead setup (UPSTREAM_PORT_PLAN.md, STL-1):
 * list them with their public link and embed snippet, and create one from
 * the Forms page's presets via forms-service (same doc as the UI makes).
 */

const MAX_SHOWN = 20;
const TEMPLATES: readonly FormTemplate[] = ["contact", "blank"];

export const FORM_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_forms",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your forms with their public links and embed snippets",
    description:
      "List this workspace's forms with id, name, enabled flag, submission count, public URL, and iframe embed snippet. Use to answer 'what forms do I have / what's my form link / how do I embed it', and ALWAYS to resolve a form's id before create_workflow (formId) — never guess ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List forms.",
    execute: async (ctx) => {
      const forms = await listFormsForSubAccount(ctx.subAccountId!);
      if (forms.length === 0) {
        return {
          resultText:
            "No forms in this workspace yet. Ask me to create one ('contact' preset: name, email, phone, message) or build one under Sidebar → Forms.",
        };
      }
      const lines = forms.slice(0, MAX_SHOWN).map(
        (f) =>
          `- “${oneLine(f.name) || "(unnamed)"}”${f.enabled ? "" : " (disabled)"} — ${f.submissionCount ?? 0} submissions, ${f.fields?.length ?? 0} fields, id: ${f.id}\n  public URL: ${formPublicUrl(f.id)}\n  embed: ${formEmbedSnippet(f.id)}`
      );
      const more =
        forms.length > MAX_SHOWN
          ? `\n(+${forms.length - MAX_SHOWN} more — see the Forms page)`
          : "";
      return {
        resultText: `Forms (${forms.length}):\n${lines.join("\n")}${more}`,
        ...(forms.length > MAX_SHOWN ? { truncated: true as const } : {}),
      };
    },
  },
  {
    name: "create_form",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Create a lead form from a preset (Contact form: name, email, phone, message)",
    description:
      "Create a new public lead-capture form in this workspace from a preset. 'contact' = Full name, Email, Phone, and a required 'How can we help?' message (the usual website contact form). 'blank' = Full name, Email, Phone, Company. Returns the public URL and the iframe embed snippet. Run list_forms first so you don't create a duplicate. Custom field layouts are edited on the Forms page afterwards.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The form's name, e.g. 'Contact us' or 'Free quote request'. Ask the user if they haven't given one — don't invent it.",
        },
        template: {
          type: "string",
          enum: [...TEMPLATES],
          description: "Preset to start from. Default 'contact'.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a form name is required" };
      if (name.length > 80) {
        return { ok: false, error: "form name is too long (80 chars max)" };
      }
      // Shown as the title of a public page.
      if (hasUnsafeText(name)) {
        return { ok: false, error: `the form name ${UNSAFE_TEXT_MESSAGE}` };
      }
      const template = (str(raw, "template") || "contact") as FormTemplate;
      if (!TEMPLATES.includes(template)) {
        return { ok: false, error: "template must be 'contact' or 'blank'" };
      }
      return { ok: true, args: { name, template } };
    },
    summarize: (args) =>
      `Create a form “${args.name}” from the ${
        args.template === "contact" ? "Contact form" : "Blank"
      } preset.`,
    execute: async (ctx, args) => {
      const name = args.name as string;
      const existing = await listFormsForSubAccount(ctx.subAccountId!);
      const dup = existing.find(
        (f) => (f.name ?? "").trim().toLowerCase() === name.toLowerCase()
      );
      if (dup) {
        throw new CapabilityUserError(
          `A form named “${oneLine(dup.name)}” already exists (id ${dup.id}, public URL ${formPublicUrl(dup.id)}). Use that one, or pick a different name.`
        );
      }
      let id: string;
      try {
        id = await createFormServerSide({
          subAccountId: ctx.subAccountId!,
          createdByUid: ctx.uid,
          name,
          template: args.template as FormTemplate,
          actor: agentActor(ctx, "create_form"),
        });
      } catch (err) {
        if (err instanceof FormServiceError) {
          throw new CapabilityUserError(err.message);
        }
        throw err;
      }
      return {
        resultText: `Created the form “${name}” (id ${id}). Public URL: ${formPublicUrl(id)}\nEmbed on a website: ${formEmbedSnippet(id)}\nSubmissions create a contact automatically; pin a workflow to this form (create_workflow with its formId) to respond instantly.`,
        ref: { kind: "form", id },
      };
    },
  },
];
