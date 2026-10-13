import type { AiSuiteCapability } from "./capabilities/types";

/**
 * The capability table of docs/features/agent-api-tools.md, rendered from the
 * registry so it can't drift: agent-api-doc.test.ts fails when the committed
 * file differs, and rewrites it with UPDATE_AGENT_API_DOCS=1. What each
 * approval's preview shows is written here by hand (the registry doesn't
 * describe it); the test requires an entry for every capability that can
 * need a person, and none for one that can't.
 */

export const PREVIEW_NOTES: Record<string, string> = {
  delete_deal: "the deal (value, stage, contact), its id and creation time, a warning if an agent created it",
  mark_deal_completed: "the deal, its Won stage and value, a warning if an agent last edited the pipeline; the exact review request or why none",
  delete_pipeline: "the pipeline, its stages, how many deals are in it; it will fail while any are",
  delete_custom_field: "the field and its key, what uses it (workflows, templates), its stored values, reuse of the key later",
  delete_custom_field_folder: "the folder; its fields move to General",
  update_product: "every asked field old -> new, what sells the product (checkout pages, funnels) and what buyers then see",
  delete_product: "the product, its price and the open quotes / invoices using it; refused while a checkout page or funnel sells it",
  delete_snippet: "the snippet's subject and body",
  update_quote: "every asked field old -> new, the line items before and after, and the total",
  send_quote: "to, from, reply-to, channel (email), payment rail, exact subject and message (links as placeholders), what happens next",
  mark_quote_paid: "amount and currency, how it is recorded, the quote.paid workflows it starts (their steps pinned), the exact review request or why none",
  create_recurring_schedule: "the whole schedule, where invoices go, whether a card is charged",
  update_recurring_schedule: "the schedule old -> new, the card outcome, any pro-rata",
  pause_recurring_schedule: "the schedule old -> new and the card outcome",
  resume_recurring_schedule: "the schedule old -> new and the card outcome",
  cancel_recurring_schedule: "the schedule old -> new and the card outcome",
  update_workflow: "which fields change, and that later enrolments and runs in progress take the new steps",
  set_workflow_status: "activating: the exact trigger and steps (pinned) and what runs from approval on",
  delete_workflow: "the workflow, its id and creation time, its trigger and steps",
  update_contact_channels: "the contact and its phone / email old -> new (pinned)",
  delete_contact: "the contact, its phone and email, what is deleted with it; it will fail while still linked",
  delete_company: "the company and how many contacts it unlinks (they keep the name as text)",
  set_bot_mode: "the conversation, the AI mode, its effect and any held replies",
  send_message: "to, from, channel, consent, the exact text (subject and reply-to for email), when",
  schedule_message: "to, from, channel, consent, the exact text, when it sends and what then happens",
  send_whatsapp_template: "to, from (the sending number), template, language, the filled text and buttons, when",
  delete_task: "the task: due, done, assignee, what it links to, notes",
  set_event_status: "cancelling: the appointment, the timeline reason, the exact notice or why none, the workflows that start (their steps pinned)",
  mark_booking_paid: "the booking and its deposit, who the confirmation email goes to or why none, the reminders, the booking.confirmed workflows that start (their steps pinned)",
  create_booking_page: "every field of the page to be published",
  delete_booking_page: "the page and that its link stops working; refused while bookings are upcoming",
  update_booking_page: "changed fields old -> new (the whole page when it goes public or has upcoming bookings)",
  delete_social_post: "the post, its id and creation time, whether a published one stays on the platform",
  schedule_social_post: "the exact post (caption, image), the Facebook Page / Instagram account, when it publishes",
  send_review_request: "the exact text, recipient, channel and template, or why none would send",
  create_broadcast: "channel, audience and matched count, exact subject and message, merge tags, what is checked at send",
  start_voice_call: "the number, assistant, the number it rings from, first words, greeting name, the script, consent, cost, what is checked at dial time",
  set_sub_account_gate: "the sub-account, the gate, its state now, on or off, and the side effect (e.g. Google off deletes the synced review cache)",
  apply_snapshot: "the sub-account, the snapshot (captured in this agency, or imported), what it creates and what it skips as already there, workflows arriving as drafts, which forms accept submissions at once, the AI persona written (with its hours) or kept; the snapshot's payload hash is pinned",
  assign_billing_plan: "the sub-account, the plan and price (a special price only if proposed), every feature switching on and off, monthly quotas and overage rates, when features change (now, or when the client pays) and what billing does; price and gates are pinned",
  create_one_time_charge: "the sub-account, the charge description and amount as the client sees them, and that it is one payment link, nothing charged until paid (pinned)",
  invite_member: "the email, the role (admin's powers named), what happens: a new invite, added at once with nothing to accept, a member's role old -> new, or that approving will refuse (a disabled or another agency's account); territories kept or cleared; whether an email goes out. The proposing agent is shown only the sub-account, email and role",
};

const ROLE: Record<string, string> = { subAccountMember: "member", subAccountAdmin: "admin", agencyOwner: "agency owner" };
const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
/** Up to the first sentence end; "e.g." and "i.e." do not end one. */
const firstSentence = (s: string) => cell((s.match(/^(?:e\.g\.|i\.e\.|.)*?[.!?](\s|$)/)?.[0] ?? s).trim());

export function kindOf(c: AiSuiteCapability): string {
  if (c.readonly) return "read";
  if (c.approval) return `\`${c.approval}\``;
  if (c.approvalHint) return `write; \`${c.approvalHint.approval}\` when ${cell(c.approvalHint.when)}`;
  return "write";
}

const row = (c: AiSuiteCapability) =>
  `| \`${c.name}\` | ${kindOf(c)} | ${ROLE[c.requiredRole] ?? c.requiredRole} | ${firstSentence(c.description)} | ${cell(PREVIEW_NOTES[c.name] ?? "")} |`;
const HEADER = ["| Tool | Kind | Role | What it does | What the approval preview shows |", "|---|---|---|---|---|"];

/** `caps`: the sub-account tools (`agentCallable`); `agencyCaps`: the agency-level ones (`agencyAgentCallable`). */
export function renderAgentToolsDoc(caps: AiSuiteCapability[], agencyCaps: AiSuiteCapability[]): string {
  return [
    "# Agent API: capability table",
    "",
    "<!-- Generated from the registry by src/lib/ai-suite/agent-api-doc.test.ts. Do not edit by hand:",
    "     rerun with `UPDATE_AGENT_API_DOCS=1 pnpm exec vitest run src/lib/ai-suite/agent-api-doc.test.ts`. -->",
    "",
    "Every tool an `agent` key can call, in the order `tools/list` returns them. **Kind**: `read`, `write`",
    "(direct; workflow enrolments it causes are still held for approval), or an approval class, meaning a",
    "person approves each call on the Approvals page. **Role**: what the key's calls need, and what the",
    "approver must hold. See [agent-api.md](agent-api.md) for the model.",
    "",
    ...HEADER,
    ...caps.map(row),
    "",
    "## Agency-key tools",
    "",
    "Only an agency key calls these, besides every tool above (where it adds a required `subAccountId`). A tool",
    "that acts in a sub-account names it in its own `subAccountId`, and the key's reach applies to it. Their",
    "approval rows are agency-level (`subAccountId: null`): only the agency owner approves them, on",
    "`/agency/approvals`. See [agent-api.md](agent-api.md#agency-keys).",
    "",
    ...HEADER,
    ...agencyCaps.map(row),
    "",
  ].join("\n");
}
