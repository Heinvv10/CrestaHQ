import type { WhatsappTemplateButton } from "@/types/whatsapp-templates";

/**
 * A template's buttons as a Cloud in-window INTERACTIVE message — sent free
 * inside the 24-hour window, with no Meta approval. This is how the Velocity
 * review link goes out behind a "Leave a review" button without becoming a
 * (likely MARKETING-priced) template send.
 *
 * Meta's in-window rules are narrower than a template's:
 *   - reply buttons: 1–3, title at most 20 characters (a template allows 25);
 *   - a link: `cta_url`, exactly ONE per message, display text at most 20;
 *   - reply buttons and a link cannot share one message;
 *   - body text at most 1024 characters.
 * A template outside those rules cannot be rendered in-window, and the caller
 * refuses the send — stripping the buttons would deliver a question nobody can
 * answer, or a review ask with no link.
 */

export type CloudInteractive =
  | {
      type: "button";
      body: { text: string };
      action: { buttons: Array<{ type: "reply"; reply: { id: string; title: string } }> };
    }
  | {
      type: "cta_url";
      body: { text: string };
      action: { name: "cta_url"; parameters: { display_text: string; url: string } };
    };

const MAX_TITLE = 20;
const MAX_BODY = 1024;

export type InteractiveResult =
  | { ok: true; interactive: CloudInteractive }
  | { ok: false; error: string };

export function interactiveFromButtons(
  body: string,
  buttons: WhatsappTemplateButton[],
): InteractiveResult {
  const text = body.trim();
  if (!text || text.length > MAX_BODY) {
    return { ok: false, error: "WA_INTERACTIVE_BODY_INVALID" };
  }
  if (buttons.some((b) => b.text.length > MAX_TITLE)) {
    return { ok: false, error: "WA_INTERACTIVE_LABEL_TOO_LONG" };
  }
  const links = buttons.filter((b) => b.type === "url");
  const replies = buttons.filter((b) => b.type === "quick_reply");

  if (links.length === 0 && replies.length > 0 && replies.length <= 3) {
    return {
      ok: true,
      interactive: {
        type: "button",
        body: { text },
        action: {
          // The id comes back as `button_reply.id`; the title is what the
          // inbound parser turns into the reply text a workflow branches on.
          buttons: replies.map((b) => ({ type: "reply", reply: { id: b.text, title: b.text } })),
        },
      },
    };
  }
  const [link] = links;
  if (links.length === 1 && replies.length === 0 && link.type === "url") {
    return {
      ok: true,
      interactive: {
        type: "cta_url",
        body: { text },
        action: { name: "cta_url", parameters: { display_text: link.text, url: link.url } },
      },
    };
  }
  return { ok: false, error: "WA_INTERACTIVE_BUTTONS_UNSUPPORTED" };
}
