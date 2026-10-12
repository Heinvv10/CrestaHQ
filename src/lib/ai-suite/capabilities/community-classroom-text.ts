import "server-only";

import { domainToUnicode } from "node:url";
import { parseVideoUrl } from "@/lib/community/video-embed";
import { str } from "./helpers";
import { hasUnsafeText, lookAlikeProblem, messageBody, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";

/**
 * What add_course / add_lesson accept from the model and how their confirm
 * card shows it: titles and text members read are refused when they hide
 * characters, and the card quotes the text with every link in it.
 */

const TITLE_MAX = 200;
/** The hosts the classroom's player embeds (lib/community/video-embed.ts). */
const VIDEO_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

/** A required, card-visible title: present, capped, nothing hidden. */
export function titleProblem(label: string, value: string): string | null {
  if (!value) return `${label} is required`;
  if (value.length > TITLE_MAX) return `${label} is too long (${TITLE_MAX} characters max)`;
  return hasUnsafeText(value) ? `${label} ${UNSAFE_TEXT_MESSAGE}` : null;
}

/** A YouTube / Vimeo https link the player can embed, or null. */
export function safeVideoUrl(raw: string): string | null {
  if (!raw || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !VIDEO_HOSTS.has(url.hostname.toLowerCase())) return null;
  return parseVideoUrl(url.href) ? url.href : null;
}

/** Optional members-visible text: cleaned, or why it is refused. */
export function bodyText(raw: unknown, key: string, label: string, max: number): { text: string } | { error: string } {
  const value = str(raw, key);
  if (!value) return { text: "" };
  const text = messageBody(value);
  if (text === null) return { error: `${label} ${UNSAFE_TEXT_MESSAGE}` };
  if (text.length > max) return { error: `${label} is too long (${max.toLocaleString("en-US")} characters max)` };
  return { text };
}

/**
 * A link as the card lists it, with a CAUTION note when it doesn't go where
 * it reads: userinfo before an "@" (https://apple.com@evil.example goes to
 * evil.example), or a host with look-alike / non-Latin letters (punycode is
 * decoded first). The host is the one the browser would use (new URL).
 */
function linkOnCard(link: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return `${link} (CAUTION: it can't be read as a web address)`;
  }
  const notes: string[] = [];
  const host = domainToUnicode(url.hostname) || url.hostname;
  const authority = link.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "";
  if (authority.includes("@")) notes.push(`it goes to ${host}, not to the part before the "@"`);
  if (!/^[\x00-\x7f]*$/.test(host)) notes.push(`its address (${host}) ${lookAlikeProblem(host, []) ?? "has non-Latin letters"}`);
  return notes.length ? `${link} (CAUTION: ${notes.join("; ")})` : link;
}

/** How the card shows text members will read: all of it (on one line), its length, and every link in it. */
export function bodyOnCard(label: string, text: string): string {
  if (!text) return "";
  const links = [...new Set(text.match(/\b(?:https?:\/\/|www\.)[^\s<>"]+/giu) ?? [])];
  return ` ${label} (${text.length.toLocaleString("en-US")} characters): “${oneLine(text)}”.${links.length ? ` Links in it: ${links.map(linkOnCard).join(", ")}.` : ""}`;
}
