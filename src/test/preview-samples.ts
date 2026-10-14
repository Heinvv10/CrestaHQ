import { QUOTE, SCHEDULE, SMTP } from "@/test/quote-fixtures";
import { PAGE, pageForm, pastEvent } from "@/test/booking-fixtures";
import { seedPr13 } from "@/test/pr13-fixtures";
import { seedSnapshots } from "@/test/snapshot-fixtures";
import { spyBillingProvider } from "@/test/billing-provider-spies";
import type { createMemoryFirestore } from "@/test/memory-firestore";

/** Sample args and seed data for chat-surface.test.ts's approval-preview
 *  invariants, kept apart so that file stays under the size cap. */

type Mem = ReturnType<typeof createMemoryFirestore>;

/** A sub-account's billing with a plan assigned and checkout not completed. */
export const PENDING_BILLING = {
  status: "pending", planId: "plan_sample", planName: "Sample plan", priceCents: 9900, billingInterval: "month", currency: "zar",
  specialPriceCents: null, stripePriceId: "price_m", stripeCustomerId: null, stripeSubscriptionId: null, checkoutTokenHash: "old_hash",
};

// Every approval capability adds sample args here; a missing entry fails
// the test. They target the contact seeded below.
export const PREVIEW_SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  update_contact_channels: { contactId: "c_sample", phone: "+27821234567", email: "new@x.io" },
  delete_contact: { contactId: "c_sample" },
  delete_company: { companyId: "co_sample" },
  set_bot_mode: { conversationId: "c_sample", mode: "auto" },
  send_message: { conversationId: "c_sample", channel: "sms", body: "Hello" },
  schedule_message: { conversationId: "c_sample", channel: "sms", body: "Hello", sendAt: "2030-01-10T08:00:00.000Z" },
  send_whatsapp_template: { conversationId: "c_sample", templateId: "tpl_sample", variables: { "1": "Tuesday" } },
  update_workflow: { workflowId: "wf_active", name: "Renamed" },
  set_workflow_status: { workflowId: "wf_paused", status: "active" },
  delete_workflow: { workflowId: "wf_paused" },
  delete_deal: { dealId: "d_sample" },
  mark_deal_completed: { dealId: "d_won" },
  delete_pipeline: { pipelineId: "p_sample" },
  delete_custom_field: { fieldId: "cf_sample" },
  delete_custom_field_folder: { folderId: "fo_sample" },
  delete_product: { productId: "pr_sample" },
  update_product: { productId: "pr_sold", unitPriceCents: 200 },
  delete_snippet: { snippetId: "sn_sample" },
  update_quote: { quoteId: "q_accepted", termsAndNotes: "New terms" },
  send_quote: { quoteId: "q_sample" },
  mark_quote_paid: { quoteId: "q_accepted" },
  create_recurring_schedule: { contactId: "c_sample", name: "Support", cadence: { unit: "month", interval: 1 }, startDateString: "2030-01-01", lineItems: [{ description: "Support", quantity: 1, unitPrice: 1000 }] },
  update_recurring_schedule: { scheduleId: "rs_sample", name: "Support plan" },
  pause_recurring_schedule: { scheduleId: "rs_sample" },
  resume_recurring_schedule: { scheduleId: "rs_paused" },
  cancel_recurring_schedule: { scheduleId: "rs_sample" },
  delete_task: { taskId: "t_sample" },
  set_event_status: { eventId: "ev_sample", status: "cancelled" },
  mark_booking_paid: { eventId: "ev_awaiting" },
  create_booking_page: pageForm("consult-2", { name: "Second consult", status: "published" }),
  update_booking_page: { slug: "bp-live", durationMinutes: 45 },
  delete_booking_page: { slug: "bp-live" },
  schedule_social_post: { postId: "sp1", scheduledAt: "2030-01-10T08:00:00.000Z" },
  delete_social_post: { postId: "sp1" },
  send_review_request: { contactId: "c_voice" },
  create_broadcast: { templateId: "tpl_email", audienceFilter: { kind: "all" } },
  start_voice_call: { contactId: "c_voice" },
  set_sub_account_gate: { subAccountId: "sa1", gate: "whatsapp", enabled: true },
  apply_snapshot: { subAccountId: "sa1", snapshotId: "snap_own" },
  invite_member: { email: "new@example.com", role: "admin" },
  assign_billing_plan: { subAccountId: "sa1", subAccountName: "", planId: "plan_sample", planName: "", interval: "month", specialPriceCents: null },
  create_one_time_charge: { subAccountId: "sa1", subAccountName: "", description: "Setup", amount: 50, amountCents: 5000, currency: "zar" },
  resend_checkout_link: { subAccountId: "sa1" },
};

/** Seeds what PREVIEW_SAMPLE_ARGS targets in sub-account sa1 of agency ag1
 *  (its WhatsApp sender is seeded by the test itself). */
export function seedPreviewSamples(mem: Mem) {
  mem.seed("contacts/c_sample", {
    subAccountId: "sa1", agencyId: "ag1", name: "Sample", phone: "+27820000000", email: "old@x.io", territoryId: "global",
  });
  mem.seed("companies/co_sample", { subAccountId: "sa1", agencyId: "ag1", name: "Sample Co" });
  mem.seed("conversations/c_sample", { subAccountId: "sa1", agencyId: "ag1", contactId: "c_sample", contactName: "Sample", botMode: "suggest" });
  mem.seed("subAccounts/sa1/whatsappTemplates/tpl_sample", {
    subAccountId: "sa1", agencyId: "ag1", name: "sample", displayName: "Sample", language: "en", status: "approved", contentSid: "HX1",
    body: "See you {{1}}.", variables: [{ position: 1, label: "Day", sampleValue: "Monday", source: "manual", mergeTag: null }],
  });
  for (const [id, status] of [["wf_active", "active"], ["wf_paused", "paused"]]) {
    mem.seed(`workflows/${id}`, {
      subAccountId: "sa1", agencyId: "ag1", name: "Sample flow", status, startNodeId: "n1",
      trigger: { type: "contact.created", filters: { all: [] } },
      nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
    });
  }
  mem.seed("deals/d_sample", { subAccountId: "sa1", agencyId: "ag1", title: "Sample deal", stageId: "new", territoryId: "global" });
  mem.seed("deals/d_won", { subAccountId: "sa1", agencyId: "ag1", title: "Won deal", stageId: "won", contactId: "c_sample", territoryId: "global" });
  mem.seed("subAccounts/sa1/customFields/cf_sample", { subAccountId: "sa1", agencyId: "ag1", entity: "contact", key: "k", label: "K", type: "text", options: [], required: false, order: 0 });
  mem.seed("subAccounts/sa1/customFieldFolders/fo_sample", { subAccountId: "sa1", agencyId: "ag1", name: "F", entity: "contact", order: 0 });
  mem.seed("products/pr_sample", { subAccountId: "sa1", agencyId: "ag1", name: "P", unitPriceCents: 100, currency: "USD", active: true });
  mem.seed("products/pr_sold", { subAccountId: "sa1", agencyId: "ag1", name: "Sold", unitPriceCents: 100, currency: "USD", active: true });
  mem.seed("subAccounts/sa1/checkoutPages/cp_sample", { subAccountId: "sa1", name: "Offer", productId: "pr_sold", bumpProductIds: [] });
  mem.seed("snippets/sn_sample", { subAccountId: "sa1", agencyId: "ag1", name: "S", type: "text", body: "Hi", subject: null, folder: null });
  mem.seed("subAccounts/sa1/pipelines/p_sample", { subAccountId: "sa1", agencyId: "ag1", name: "Sample", isDefault: false, stages: [{ id: "a", label: "A", tone: "" }] });
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), ...SMTP });
  mem.seed("quotes/q_sample", { ...QUOTE, contactId: "c_sample" });
  mem.seed("quotes/q_accepted", { ...QUOTE, contactId: "c_sample", status: "accepted" });
  mem.seed("recurringInvoices/rs_sample", { ...SCHEDULE, contactId: "c_sample" });
  mem.seed("recurringInvoices/rs_paused", { ...SCHEDULE, contactId: "c_sample", status: "paused" });
  mem.seed("tasks/t_sample", { subAccountId: "sa1", agencyId: "ag1", title: "Call", contactId: "c_sample", territoryId: "global" });
  mem.seed("events/ev_sample", pastEvent({ contactId: "c_sample" }));
  mem.seed("events/ev_awaiting", pastEvent({ contactId: "c_sample", status: "awaiting_payment" }));
  mem.seed("subAccounts/sa1/bookingPages/bp-live", { ...PAGE, id: "bp-live", slug: "bp-live", status: "published" });
  seedPr13(mem);
  seedSnapshots(mem);
  // A plan assigned and not yet paid: what resend_checkout_link mints a link for.
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1"), billing: PENDING_BILLING });
  mem.seed("agencies/ag1/plans/plan_sample", {
    name: "Sample plan", status: "active", currency: "zar", priceMonthlyCents: 9900, priceAnnualCents: null, gates: { broadcastsEnabledByAgency: true },
  });
  // A charge can only be previewed with a payment provider configured (spied: nothing reaches it).
  spyBillingProvider("stripe");
  mem.seed("contacts/c_voice", { subAccountId: "sa1", agencyId: "ag1", name: "Vee", phone: "+27821234567", email: "vee@x.io", territoryId: "global" });
}
