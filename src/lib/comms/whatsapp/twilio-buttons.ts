import type { WhatsappTemplateButton } from "@/types/whatsapp-templates";

/**
 * A template's buttons as a Twilio Content resource.
 *
 * Twilio's rules are narrower than Meta's direct API (Twilio docs, Content
 * types — quick-reply, call-to-action, card):
 *   - every button in a template must be the SAME action type, so quick
 *     replies and links never share one template;
 *   - button titles are at most 20 characters (Meta direct allows 25).
 * A template outside them is refused at submit with a message saying so,
 * rather than Twilio rejecting it with a status the operator can't act on.
 */

const MAX_TITLE = 20;

export function twilioButtonProblem(buttons: WhatsappTemplateButton[]): string | null {
  const kinds = new Set(buttons.map((b) => b.type));
  if (kinds.size > 1) {
    return "On Twilio a template's buttons must all be quick replies or all be links — not both. Split it into two templates, or submit from a Cloud sender.";
  }
  const long = buttons.find((b) => b.text.length > MAX_TITLE);
  if (long) {
    return `On Twilio button text is limited to ${MAX_TITLE} characters — shorten "${long.text}".`;
  }
  return null;
}

/** The Content API `types` block: text, quick-reply, or call-to-action. */
export function twilioContentTypes(
  body: string,
  buttons: WhatsappTemplateButton[] = [],
): Record<string, unknown> {
  if (buttons.length === 0) return { "twilio/text": { body } };
  if (buttons.every((b) => b.type === "quick_reply")) {
    return {
      "twilio/quick-reply": {
        body,
        // `id` comes back as ButtonPayload; the title as Body/ButtonText.
        actions: buttons.map((b) => ({ title: b.text, id: b.text })),
      },
    };
  }
  return {
    "twilio/call-to-action": {
      body,
      actions: buttons.map((b) => ({
        type: "URL",
        title: b.text,
        url: b.type === "url" ? b.url : "",
      })),
    },
  };
}
