import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { enrollForTest } from "@/lib/workflows/engine";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";

/**
 * test_workflow (UPSTREAM_PORT_PLAN.md, STL-1): enrol one contact in a
 * workflow now, as the builder's test button does. It SENDS REAL messages,
 * so it is chat-only (an admin confirms the card); the Agent API never
 * offers it. enrollForTest re-anchors the workflow and the contact to the
 * sub-account.
 */

export const WORKFLOW_TEST_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "test_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel:
      "Run a workflow once for a chosen contact as a test (sends real messages)",
    description:
      "Enrol ONE contact in a workflow right now as a test — it ignores the trigger and filters, works on a draft, and SENDS REAL SMS/email/WhatsApp to that contact. Recommend the user's own contact record (find_contacts by their name or email) so nobody else gets test messages. Resolve both ids first (list_workflows, find_contacts) — never guess. The result appears under the workflow's Runs tab.",
    parameters: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description: "The workflow's id from list_workflows.",
        },
        workflowName: {
          type: "string",
          description: "The workflow's name, for the card.",
        },
        contactId: {
          type: "string",
          description: "The contact to enrol, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description: "The contact's name, for the card.",
        },
      },
      required: ["workflowId", "workflowName", "contactId", "contactName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      const contactId = str(raw, "contactId");
      if (!isDocId(workflowId) || !isDocId(contactId)) {
        return {
          ok: false,
          error:
            "both the workflow id and the contact id are required — look them up first",
        };
      }
      return {
        ok: true,
        args: {
          workflowId,
          workflowName: str(raw, "workflowName"),
          contactId,
          contactName: str(raw, "contactName"),
        },
      };
    },
    summarize: (args) =>
      `Run the workflow “${args.workflowName || args.workflowId}” once for ${
        args.contactName || args.contactId
      } as a test — this sends REAL messages to that contact.`,
    execute: async (ctx, args) => {
      const res = await enrollForTest({
        subAccountId: ctx.subAccountId!,
        workflowId: args.workflowId as string,
        contactId: args.contactId as string,
      });
      if (!res.ok) {
        throw new CapabilityUserError(res.error ?? "The test couldn't start.");
      }
      return {
        resultText: `Test run started for ${
          args.contactName || args.contactId
        }. Instant steps send within seconds; check the Runs tab on the workflow (and the contact's timeline) to see each step.`,
        ref: { kind: "workflow", id: args.workflowId as string },
      };
    },
  },
];
