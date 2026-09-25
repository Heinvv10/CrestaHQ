import "server-only";

import {
  createWorkflowServerSide,
  type WorkflowTemplate,
} from "@/lib/server/workflows-service";
import { type AiSuiteCapability } from "./types";
import { agentActor, str, WORKFLOW_TEMPLATES } from "./helpers";

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
      return { ok: true, args: { template, name } };
    },
    summarize: (args) => {
      const label = WORKFLOW_TEMPLATES[args.template as WorkflowTemplate];
      return `Create a “${label}” workflow (draft)${
        args.name ? ` named “${args.name}”` : ""
      }.`;
    },
    execute: async (ctx, args) => {
      const template = args.template as WorkflowTemplate;
      const label = WORKFLOW_TEMPLATES[template];
      const id = await createWorkflowServerSide({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        name: (args.name as string) || label,
        template,
        actor: agentActor(ctx, "create_workflow"),
      });
      return {
        resultText: `Created the “${label}” workflow as a draft. Open Workflows to review and publish it.`,
        ref: { kind: "workflow", id },
      };
    },
  },
];
