import type {
  BuilderStep,
} from "@/lib/workflows/builder-tree";
import type {
  ConditionOp,
  WorkflowNodeType,
  WorkflowTriggerType,
} from "@/types/workflows";

export const TRIGGER_LABELS: Record<WorkflowTriggerType, string> = {
  "form.submitted": "Form submitted",
  "contact.created": "Contact created",
  "contact.tag.added": "Tag added to contact",
  "pipeline.stage.changed": "Pipeline stage changed",
  "deal.created": "Deal created",
  "deal.won": "Deal won",
  "deal.lost": "Deal lost",
  "booking.created": "Booking created",
  "booking.cancelled": "Booking cancelled",
  "booking.rescheduled": "Booking rescheduled",
  "booking.confirmed": "Booking confirmed",
  "booking.showed": "Booking showed",
  "booking.no_show": "Booking no-show",
  "quote.accepted": "Quote accepted",
  "quote.paid": "Quote/invoice paid",
  "message.received": "Message received (inbox)",
  "order.paid": "Order paid (card)",
  "invoice.charge_succeeded": "Invoice card charge succeeded",
  "invoice.charge_failed": "Invoice card charge failed",
  "link.clicked": "Tracked link clicked",
  "prospecting.report.ready": "Prospect report ready",
};

export const NODE_LABELS: Record<WorkflowNodeType, string> = {
  send_email: "Send email",
  send_sms: "Send SMS",
  whatsapp_template: "Send WhatsApp template",
  send_whatsapp: "Send WhatsApp",
  wait: "Wait",
  wait_for_reply: "Wait for reply",
  if_else: "If / else",
  goal: "End workflow",
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  move_stage: "Move pipeline stage",
  update_field: "Update field",
  create_task: "Create task",
  notify: "Internal notification",
  webhook: "Webhook",
};

/**
 * Integration a node needs to actually run. The builder flags nodes whose
 * requirement isn't configured (deployment env or, for SMS, a sub-account's
 * dedicated Twilio) so the operator sees a doomed step before activating.
 * Node types not listed have no external dependency.
 */
export type NodeRequirement = "email" | "sms" | "whatsapp";
export const NODE_REQUIREMENT: Partial<Record<WorkflowNodeType, NodeRequirement>> =
  {
    send_email: "email",
    notify: "email",
    send_sms: "sms",
    whatsapp_template: "whatsapp",
    send_whatsapp: "whatsapp",
  };

/** Step types offerable from the "add step" menu, in display order. */
export const ADDABLE_TYPES: WorkflowNodeType[] = [
  "send_email",
  "send_sms",
  "send_whatsapp",
  "whatsapp_template",
  "wait",
  "wait_for_reply",
  "add_tag",
  "remove_tag",
  "move_stage",
  "update_field",
  "create_task",
  "notify",
  "webhook",
  "if_else",
  "goal",
];

/**
 * The one condition field that does not live on the contact: the message body
 * that resumed a `wait_for_reply`. Declared here rather than in conditions.ts
 * because that module is `server-only` and the builder needs the same string —
 * two copies drift the moment one side is renamed.
 *
 * Only meaningful on an `if_else`. A trigger filter is evaluated with no reply
 * context, so a condition on this field there reads null and can never mean
 * what its author intended.
 */
export const REPLY_TEXT_FIELD = "reply.text";

export const CONDITION_OPS: { value: ConditionOp; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "is_set", label: "is set" },
  { value: "not_set", label: "is empty" },
  { value: "has_tag", label: "has tag" },
  { value: "not_has_tag", label: "does not have tag" },
  { value: "in_stage", label: "is in stage" },
  { value: "source_is", label: "source is" },
];

export function defaultConfig(type: WorkflowNodeType): Record<string, unknown> {
  switch (type) {
    case "send_email":
      return { subject: "", body: "" };
    case "send_sms":
      return { body: "" };
    case "whatsapp_template":
      // Empty senderId = the sub-account's default sender.
      return { templateId: "", manualValues: {}, senderId: "" };
    case "send_whatsapp":
      return { body: "", templateId: "", manualValues: {} };
    case "wait":
      return { seconds: 86_400 };
    case "wait_for_reply":
      return { seconds: 2 * 86_400 };
    case "if_else":
      return { conditions: { all: [] } };
    case "add_tag":
    case "remove_tag":
      return { tag: "" };
    case "move_stage":
      return { stage: "new" };
    case "update_field":
      return { field: "", value: "" };
    case "create_task":
      return { title: "", dueInDays: 1 };
    case "notify":
      return { recipient: "owner", to: "", subject: "", body: "" };
    case "webhook":
      return { url: "" };
    default:
      return {};
  }
}

/** Short human summary shown on a collapsed step card. */
export function nodeSummary(step: BuilderStep): string {
  const c = step.config;
  switch (step.type) {
    case "send_email":
      return (c.subject as string) || "No subject yet";
    case "send_sms":
      return (c.body as string)?.slice(0, 60) || "No message yet";
    case "whatsapp_template":
      return (c.templateId as string) ? "WhatsApp template" : "Choose a template";
    case "send_whatsapp":
      return (c.body as string)?.slice(0, 60) || "No message yet";
    case "wait": {
      const s = Number(c.seconds ?? 0);
      if (s % 86_400 === 0) return `Wait ${s / 86_400} day(s)`;
      if (s % 3_600 === 0) return `Wait ${s / 3_600} hour(s)`;
      return `Wait ${Math.round(s / 60)} min`;
    }
    case "wait_for_reply": {
      const s = Number(c.seconds ?? 0);
      const win =
        s % 86_400 === 0
          ? `${s / 86_400} day(s)`
          : s % 3_600 === 0
            ? `${s / 3_600} hour(s)`
            : `${Math.round(s / 60)} min`;
      return `Up to ${win}`;
    }
    case "if_else": {
      const n = ((c.conditions as { all?: unknown[] })?.all ?? []).length;
      return n ? `${n} condition(s)` : "No conditions yet";
    }
    case "add_tag":
    case "remove_tag":
      return (c.tag as string) || "No tag yet";
    case "move_stage":
      return `→ ${(c.stage as string) || "?"}`;
    case "update_field":
      return c.field ? `${c.field} = ${c.value ?? ""}` : "No field yet";
    case "create_task":
      return (c.title as string) || "Untitled task";
    case "notify":
      return (c.subject as string) || (c.to as string) || "Notification";
    case "webhook":
      return (c.url as string) || "No URL yet";
    case "goal":
      return "Ends the workflow here";
    default:
      return "";
  }
}
