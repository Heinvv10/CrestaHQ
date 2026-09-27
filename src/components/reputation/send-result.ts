/**
 * The review-request dispatcher's result (`/api/comms/review-request/send`),
 * in plain words for the Send Review Request dialog. Reasons are the
 * dispatcher's `SendReviewResult.reason` values (lib/reviews/request.ts).
 */
const REASONS: Record<string, string> = {
  not_configured: "Set your review link first (Settings Sub-Account → Messaging tab).",
  trigger_disabled: "Review requests are turned off for this sub-account.",
  no_contact: "That contact no longer exists.",
  no_phone: "This contact has no phone number.",
  opted_out: "This contact has opted out of the channel review requests use.",
  cooldown: "This contact was asked for a review recently.",
  sms_not_configured: "SMS isn't set up for this sub-account.",
  whatsapp_gate_off: "WhatsApp is turned off for this sub-account by your agency.",
  whatsapp_not_configured: "WhatsApp isn't connected for this sub-account.",
  window_closed:
    "This contact hasn't messaged you on WhatsApp in the last 24 hours, so a free-form WhatsApp message can't be sent. Use an approved template or SMS for review requests.",
  rail_has_no_templates:
    "This WhatsApp connection can't send templates. Switch review requests to the in-window WhatsApp message or SMS.",
  no_template: "No WhatsApp review template is chosen in the review-request settings.",
  template_not_approved: "The WhatsApp review template isn't approved yet.",
  template_var_missing: "The WhatsApp review template needs a value this contact doesn't have (for example a first name).",
  listing_url_not_configured:
    "This listing has no review link yet. Adopt it on the Google Business page first.",
  listing_needs_template:
    "An approved WhatsApp template carries the main listing's link. Switch review requests to SMS or the in-window WhatsApp message to send for this listing.",
};

export function sendResultMessage(reason: string | undefined): string {
  return (reason && REASONS[reason]) || "The review request couldn't be sent. Please try again.";
}
