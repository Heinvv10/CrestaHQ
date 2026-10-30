import {
  isWhatsappMergeTag,
  type WhatsappTemplateButton,
  type WhatsappTemplateVariable,
} from "@/types/whatsapp-templates";
import { optKeyword, WHATSAPP_STOP_WORDS } from "@/lib/comms/whatsapp/opt-keywords";

/**
 * Shared validation for WhatsApp template bodies + variables. Used by the
 * create + edit routes so both enforce the same rules: positions must be
 * contiguous from {{1}}, every body placeholder has a matching variable
 * definition (and vice-versa), each variable has a sample value (Meta needs
 * it for review), and merge-tag-sourced variables map to an allow-listed tag.
 */

/** Parse the distinct positional placeholders ({{1}}, {{2}}…) in a body. */
export function parseBodyPositions(body: string): number[] {
  const out = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

export function sanitiseVariables(
  raw: unknown,
  body: string,
  /** The sub-account's contact custom-field keys — see isWhatsappMergeTag. */
  contactCustomFieldKeys: ReadonlySet<string> = new Set(),
): { variables: WhatsappTemplateVariable[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "variables must be an array" };
  const positions = parseBodyPositions(body);
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] !== i + 1) {
      return {
        error: `Template variables must be numbered contiguously from {{1}}. Found {{${positions[i]}}} out of sequence.`,
      };
    }
  }
  const byPos = new Map<number, WhatsappTemplateVariable>();
  for (const v of raw) {
    if (!v || typeof v !== "object") return { error: "Invalid variable entry" };
    const r = v as Record<string, unknown>;
    const position = Number(r.position);
    if (!Number.isInteger(position) || position < 1) {
      return { error: "Each variable needs a positive integer position" };
    }
    const label = typeof r.label === "string" ? r.label.trim().slice(0, 80) : "";
    const sampleValue =
      typeof r.sampleValue === "string" ? r.sampleValue.trim().slice(0, 400) : "";
    if (!sampleValue) {
      return {
        error: `Variable {{${position}}} needs a sample value for Meta review.`,
      };
    }
    const source = r.source === "merge_tag" ? "merge_tag" : "manual";
    let mergeTag: string | null = null;
    if (source === "merge_tag") {
      mergeTag = typeof r.mergeTag === "string" ? r.mergeTag.trim() : "";
      if (!mergeTag || !isWhatsappMergeTag(mergeTag, contactCustomFieldKeys)) {
        return { error: `Variable {{${position}}} maps to an unknown merge tag.` };
      }
    }
    byPos.set(position, {
      position,
      label: label || `Value ${position}`,
      sampleValue,
      source,
      mergeTag,
    });
  }
  if (byPos.size !== positions.length) {
    return {
      error: `The body has ${positions.length} variable(s) but ${byPos.size} were defined.`,
    };
  }
  for (const p of positions) {
    if (!byPos.has(p)) return { error: `Missing definition for {{${p}}}.` };
  }
  return { variables: positions.map((p) => byPos.get(p)!) };
}

/**
 * A link button may instead be exactly one of these merge tags. It is filled
 * in per contact when the step sends, so the button only works as a free
 * in-window message on the Cloud rail: such a template can't be submitted for
 * approval (Meta needs a fixed URL) and isn't sent on Twilio (its in-session
 * Content resource is cached per template, not per contact).
 */
export const LINK_MERGE_TAGS: ReadonlyArray<string> = ["{{prospecting.reportUrl}}"];

export function isLinkMergeTag(url: string): boolean {
  return LINK_MERGE_TAGS.includes(url.trim());
}

/** True when any link button is filled in per contact. */
export function hasLinkMergeTag(buttons: WhatsappTemplateButton[]): boolean {
  return buttons.some((b) => b.type === "url" && isLinkMergeTag(b.url));
}

/** Meta's limits: 25 characters of button text, 2000 of URL. We cap the
 *  count at 3 so one definition renders on every rail (an in-window
 *  interactive message allows 3 reply buttons). */
export const MAX_TEMPLATE_BUTTONS = 3;
const MAX_BUTTON_TEXT = 25;
const MAX_BUTTON_URL = 2000;
const MAX_URL_BUTTONS = 2;

/**
 * Validate a template's buttons. Returns them quick replies first — Meta
 * requires quick replies grouped together ahead of call-to-action buttons —
 * otherwise in the order given.
 *
 * A quick reply's text comes back as the customer's message, and every
 * inbound route reads a whole message of STOP / OPT OUT / … as an opt-out.
 * So a "Stop" button is refused here rather than silently unsubscribing
 * whoever taps it.
 */
export function sanitiseButtons(
  raw: unknown,
  /** Meta allows only one-time-password buttons on AUTHENTICATION templates. */
  category?: string,
): { buttons: WhatsappTemplateButton[] } | { error: string } {
  if (raw === undefined || raw === null) return { buttons: [] };
  if (!Array.isArray(raw)) return { error: "buttons must be an array" };
  if (raw.length > 0 && category === "AUTHENTICATION") {
    return { error: "Authentication templates can't carry buttons." };
  }
  if (raw.length > MAX_TEMPLATE_BUTTONS) {
    return { error: `A template can have at most ${MAX_TEMPLATE_BUTTONS} buttons.` };
  }
  const out: WhatsappTemplateButton[] = [];
  for (const b of raw) {
    const r = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text || text.length > MAX_BUTTON_TEXT || /[\r\n]/.test(text)) {
      return { error: `Button text must be 1–${MAX_BUTTON_TEXT} characters on one line.` };
    }
    if (out.some((o) => o.text.toLowerCase() === text.toLowerCase())) {
      return { error: `Two buttons can't both say "${text}".` };
    }
    if (r.type === "quick_reply") {
      if (WHATSAPP_STOP_WORDS.has(optKeyword(text))) {
        return {
          error: `"${text}" is an opt-out keyword — tapping it would unsubscribe the customer. Reword it.`,
        };
      }
      out.push({ type: "quick_reply", text });
    } else if (r.type === "url") {
      const url = typeof r.url === "string" ? r.url.trim() : "";
      if (isLinkMergeTag(url)) {
        out.push({ type: "url", text, url });
        continue;
      }
      if (!/^https:\/\/\S+$/i.test(url) || url.length > MAX_BUTTON_URL) {
        return { error: `The "${text}" button needs a full https:// link.` };
      }
      // `{{1}}` in a URL makes Meta treat it as dynamic, which needs a sample
      // at submission and a parameter on every send — neither exists here.
      if (url.includes("{{")) {
        return { error: `The "${text}" link can't contain a {{variable}} — use a fixed URL.` };
      }
      out.push({ type: "url", text, url });
    } else {
      return { error: "Each button must be a quick reply or a link." };
    }
  }
  if (out.filter((b) => b.type === "url").length > MAX_URL_BUTTONS) {
    return { error: `A template can have at most ${MAX_URL_BUTTONS} link buttons.` };
  }
  const quick = out.filter((b) => b.type === "quick_reply");
  return { buttons: [...quick, ...out.filter((b) => b.type !== "quick_reply")] };
}

/** Derive a Meta-compliant template name (lowercase + underscores) from a
 *  free-text display name. */
export function toMetaTemplateName(displayName: string): string {
  const cleaned = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 512);
  return cleaned || "template";
}
