import "server-only";

import {
  createWorkflowServerSide,
  type WorkflowTemplate,
} from "@/lib/server/workflows-service";
import { isDocId } from "@/lib/server/doc-id";
import { getFormForSubAccount } from "@/lib/server/forms-service";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str, WORKFLOW_TEMPLATES } from "./helpers";
import { oneLine } from "./text-safety";

/** The starters whose trigger is form.submitted: the only ones a formId
 *  can narrow (workflows.forms.test.ts checks this against the seeds). */
export const FORM_TRIGGERED_TEMPLATES: readonly WorkflowTemplate[] = ["blank", "speed-to-lead", "lead-nurture"];

export const WORKFLOW_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "create_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Create an automation workflow from a starter template (as a draft)",
    description:
      "Create a new automation workflow (as a draft) from a starter template in this sub-account. Use when the user asks to create/build/add a workflow or automation.",
    parameters: {
      type: "object",
      properties: {
        template: {
          type: "string",
          enum: [
            "blank",
            "speed-to-lead",
            "appointment-confirmation",
            "lead-nurture",
            "stage-change-followup",
          ],
          description:
            "Which starter to use. 'blank' for an empty workflow, or a named template.",
        },
        name: {
          type: "string",
          description: "Optional name. Defaults to the template's name.",
        },
        formId: {
          type: "string",
          description:
            "Optional, for a form-triggered starter (blank, speed-to-lead, lead-nurture): pin it to ONE form so it only fires for that form's submissions. Use the id exactly as returned by list_forms. Omit = fires for every form.",
        },
        formName: {
          type: "string",
          description: "The form's name (when formId is set), for the card.",
        },
      },
      required: ["template"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const template = str(raw, "template");
      if (!(template in WORKFLOW_TEMPLATES)) {
        return {
          ok: false,
          error:
            "pick a template: blank, speed-to-lead, appointment-confirmation, lead-nurture, or stage-change-followup",
        };
      }
      const name = str(raw, "name");
      const formId = str(raw, "formId");
      if (!formId) return { ok: true, args: { template, name } };
      if (!isDocId(formId)) return { ok: false, error: "formId must be a form id from list_forms" };
      if (!FORM_TRIGGERED_TEMPLATES.includes(template as WorkflowTemplate)) {
        return { ok: false, error: `a formId only applies to a form-triggered starter: ${FORM_TRIGGERED_TEMPLATES.join(", ")}` };
      }
      return { ok: true, args: { template, name, formId, formName: str(raw, "formName") } };
    },
    summarize: (args) => {
      const label = WORKFLOW_TEMPLATES[args.template as WorkflowTemplate];
      return `Create a “${label}” workflow (draft)${
        args.name ? ` named “${args.name}”` : ""
      }${args.formId ? `, triggered only by the “${args.formName || args.formId}” form` : ""}.`;
    },
    execute: async (ctx, args) => {
      const template = args.template as WorkflowTemplate;
      const label = WORKFLOW_TEMPLATES[template];
      const formId = (args.formId as string | undefined) || undefined;
      // Re-anchor the model-supplied form id to THIS workspace before it
      // lands on the trigger.
      const form = formId ? await getFormForSubAccount(ctx.subAccountId!, formId) : null;
      if (formId && !form) {
        throw new CapabilityUserError("That form wasn't found in this workspace — check list_forms.");
      }
      const id = await createWorkflowServerSide({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        name: (args.name as string) || label,
        template,
        actor: agentActor(ctx, "create_workflow"),
        formId,
      });
      return {
        resultText: `Created the “${label}” workflow as a draft${
          form ? `, triggered only by the “${oneLine(form.name)}” form` : ""
        }. Open Workflows to review and publish it.`,
        ref: { kind: "workflow", id },
      };
    },
  },
];
