import { escapeHtml } from "./escape-html";

/**
 * The one layout every system mail uses — password resets, invites, billing
 * links, usage alerts. Callers supply words and an optional button; the
 * branding, spacing and plain-text twin come from here, so the mails cannot
 * drift apart.
 *
 * Email-client safe: tables, inline styles, no SVG (Gmail strips it) and no
 * web fonts. The brand mark is the agency logo when it has an https URL,
 * else a coloured initial.
 */
export interface SystemEmailBrand {
  name: string;
  logoUrl?: string | null;
  supportEmail?: string | null;
}

export interface SystemEmail {
  brand: SystemEmailBrand;
  /** Inbox preview line, hidden in the body. */
  preview: string;
  heading: string;
  /** Plain text, HTML-escaped. Pass segments to bold part of a line. */
  paragraphs: Text[];
  /** http(s) or a relative path; any other scheme throws. */
  button?: { label: string; url: string };
  /** Small grey line under the button, e.g. expiry or "ignore if not you". */
  note?: string;
}

/**
 * A line of copy: a string, or segments where `{ bold }` renders bold.
 * Structured rather than markdown-ish so a caller's value (a workspace
 * named `a**b`) can never toggle formatting.
 */
export type Text = string | ReadonlyArray<string | { bold: string }>;

const ACCENT = "#7c3aed";
const INK = "#0a0a0f";
const BODY = "#4a4a55";
const MUTED = "#8a8a95";
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function inline(text: Text): string {
  if (typeof text === "string") return escapeHtml(text);
  return text
    .map((seg) =>
      typeof seg === "string"
        ? escapeHtml(seg)
        : `<strong style="color:${INK};">${escapeHtml(seg.bold)}</strong>`,
    )
    .join("");
}

function plain(text: Text): string {
  if (typeof text === "string") return text;
  return text.map((seg) => (typeof seg === "string" ? seg : seg.bold)).join("");
}

function brandMark(brand: SystemEmailBrand): string {
  const name = escapeHtml(brand.name);
  const initial = escapeHtml(brand.name.trim().charAt(0).toUpperCase() || "•");
  const mark =
    brand.logoUrl && /^https:\/\//.test(brand.logoUrl)
      ? `<td width="32" height="32" style="width:32px; height:32px;"><img src="${escapeHtml(brand.logoUrl)}" alt="" width="32" height="32" style="display:block; width:32px; height:32px; border:0; border-radius:8px;"></td>`
      : `<td width="32" height="32" align="center" style="width:32px; height:32px; background:${ACCENT}; background-image:linear-gradient(135deg,#6366f1,#a855f7 55%,#ec4899); border-radius:8px; color:#ffffff; font-size:16px; font-weight:700; font-family:${FONT};">${initial}</td>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
${mark}
<td style="padding-left:10px; font-size:17px; font-weight:700; color:${INK}; letter-spacing:-0.01em; font-family:${FONT};">${name}</td>
</tr></table>`;
}

export function renderSystemEmail(email: SystemEmail): {
  html: string;
  text: string;
} {
  const { brand, button, note } = email;
  // A scheme other than http(s) (javascript:, data:) is refused. A relative
  // path is let through: invites build one when NEXT_PUBLIC_APP_URL is unset.
  // Browsers drop tabs, newlines and spaces inside a scheme ("java\tscript:").
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(
    (button?.url ?? "").replace(/[\x00-\x20]/g, ""),
  )?.[1];
  if (scheme && !/^https?$/i.test(scheme)) {
    throw new Error("System email button URL must be http(s).");
  }
  const paragraphs = email.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px 0; font-size:15px; line-height:1.6; color:${BODY};">${inline(p)}</p>`,
    )
    .join("\n");
  const url = button ? escapeHtml(button.url) : "";
  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 0 0;"><tr>
<td style="border-radius:10px; background:${ACCENT};"><a href="${url}" style="display:inline-block; padding:13px 26px; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:10px; font-family:${FONT};">${escapeHtml(button.label)}</a></td>
</tr></table>
<p style="margin:22px 0 0 0; font-size:12px; line-height:1.5; color:${MUTED};">Button not working? Paste this link into your browser:<br><a href="${url}" style="color:${ACCENT}; word-break:break-all;">${url}</a></p>`
    : "";
  const noteHtml = note
    ? `<p style="margin:18px 0 0 0; font-size:13px; line-height:1.5; color:${MUTED};">${inline(note)}</p>`
    : "";
  const support = brand.supportEmail?.trim();
  const footer = support
    ? `Questions? <a href="mailto:${escapeHtml(support)}" style="color:${MUTED};">${escapeHtml(support)}</a>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(email.heading)}</title>
</head>
<body style="margin:0; padding:0; background:#f4f3f8; font-family:${FONT}; color:${INK};">
<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(email.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3f8; padding:36px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;">
<tr><td style="padding:0 4px 18px 4px;">${brandMark(brand)}</td></tr>
<tr><td style="background:#ffffff; border-radius:16px; border-top:4px solid ${ACCENT}; padding:34px 32px 30px 32px; box-shadow:0 1px 3px rgba(16,16,32,0.06);">
<h1 style="margin:0 0 16px 0; font-size:22px; line-height:1.3; font-weight:650; color:${INK}; letter-spacing:-0.01em;">${escapeHtml(email.heading)}</h1>
${paragraphs}
${buttonHtml}
${noteHtml}
</td></tr>
<tr><td style="padding:20px 8px 0 8px; font-size:12px; line-height:1.6; color:${MUTED}; text-align:center;">Sent by ${escapeHtml(brand.name)}. ${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    email.heading,
    "",
    ...email.paragraphs.flatMap((p) => [plain(p), ""]),
    ...(button ? [`${button.label}: ${button.url}`, ""] : []),
    ...(note ? [plain(note), ""] : []),
    `Sent by ${brand.name}.${support ? ` Questions? ${support}` : ""}`,
  ].join("\n");

  return { html, text };
}
