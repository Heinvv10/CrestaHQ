/**
 * Parsers for Meta's WhatsApp Cloud webhook payload.
 *
 * Pure and total by design: this endpoint is public, and the signature check
 * runs on the raw body, so junk reaches these functions routinely. Nothing
 * here throws — malformed input yields null or an empty list and the caller
 * acks with 200, because a non-2xx makes Meta retry and eventually disable the
 * subscription.
 *
 * Meta's envelope nests deeply and inconsistently:
 *   entry[].changes[].value.{ metadata, contacts[], messages[] | statuses[] }
 * Inbound messages and delivery receipts arrive on the SAME endpoint and are
 * distinguished only by which key is present.
 */

import type { WhatsappMediaKind } from "@/types/whatsapp-media";
import {
  parseWhatsappLocation,
  type WhatsappLocation,
} from "@/types/whatsapp-location";

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Json)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Every `value` block, across every entry and change. Meta may batch
 *  several into one delivery, so reading only the first loses the rest. */
function allValues(payload: unknown): Json[] {
  const out: Json[] = [];
  const root = asObject(payload);
  if (!root) return out;
  for (const entry of asArray(root.entry)) {
    const e = asObject(entry);
    if (!e) continue;
    for (const change of asArray(e.changes)) {
      const value = asObject(asObject(change)?.value);
      if (value) out.push(value);
    }
  }
  return out;
}

function phoneNumberIdOf(value: Json): string {
  const id = asObject(value.metadata)?.phone_number_id;
  return typeof id === "string" ? id.trim() : "";
}

/**
 * The recipient number's Meta id — the routing key that says which
 * sub-account this webhook belongs to.
 */
export function parseCloudPhoneNumberId(payload: unknown): string | null {
  const first = allValues(payload)[0];
  return (first && phoneNumberIdOf(first)) || null;
}

export interface CloudInbound {
  /** The recipient number's Meta id from this message's own `value` block —
   *  the routing key, per message, since one delivery can carry several. */
  phoneNumberId: string;
  fromPhone: string;
  text: string;
  providerMessageId: string;
  profileName: string;
  /** The tapped button's payload (quick reply) or id (interactive reply);
   *  null for anything that was not a button tap. */
  buttonPayload: string | null;
  /** The file Meta says this message carried, before it has been fetched.
   *  Null for text, buttons, and a media block with no id. */
  media: CloudMediaRef | null;
  /** A shared location (`type: "location"`), validated. Null otherwise. */
  location: WhatsappLocation | null;
  /** True when the message WAS a location but its coordinates were unusable,
   *  so the caller can log the drop. */
  locationRejected: boolean;
  /** When the customer sent it — Meta's `timestamp` — in ms; null when absent. */
  timestampMs: number | null;
}

export interface CloudMediaRef {
  /** From the message `type`, not the mime: a sticker is `image/webp`. */
  kind: WhatsappMediaKind;
  /** Meta's media id — the handle for `GET /{version}/{id}`. */
  id: string;
  /** As Meta declared it. Checked against the allow-list by the caller. */
  mimeType: string;
  /** `document.filename`, capped; otherwise synthesised from kind + mime. */
  filename: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Meta's `timestamp` (Unix seconds, a digit string) → ms; null when absent or malformed. */
function timestampMs(v: unknown): number | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{1,12}$/.test(s) ? Number(s) * 1000 : null;
}

const MEDIA_KINDS: readonly WhatsappMediaKind[] = [
  "image",
  "audio",
  "video",
  "document",
  "sticker",
];

/** The name is the sender's and unbounded, and it lands on the row. Matches
 *  the bridge's `maxMediaFilenameBytes`. */
const MAX_MEDIA_FILENAME_BYTES = 255;

/** Longest prefix of `s` that fits in `maxBytes` of UTF-8, cut on a code point
 *  so a multi-byte character is never split into a replacement char. */
function truncateUtf8(s: string, maxBytes: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Caps a filename at MAX_MEDIA_FILENAME_BYTES, keeping a short extension so the
 * operator still sees what kind of file it was.
 *
 * Deliberately the same algorithm as `capFilename` in the bridge webhook route
 * (PR #148), written again rather than imported from an unmerged branch. The
 * two should become one helper once both have landed.
 */
function capFilename(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_MEDIA_FILENAME_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const ext =
    dot > 0 && Buffer.byteLength(name.slice(dot), "utf8") <= 16
      ? name.slice(dot)
      : "";
  const stem = truncateUtf8(
    name.slice(0, name.length - ext.length),
    MAX_MEDIA_FILENAME_BYTES - Buffer.byteLength(ext, "utf8"),
  );
  return stem + ext;
}

const SYNTH_STEM: Record<WhatsappMediaKind, string> = {
  image: "photo",
  audio: "voice-note",
  video: "video",
  document: "document",
  sticker: "sticker",
};

/** `image/jpeg` → `jpg`, `audio/ogg; codecs=opus` → `ogg`. Only for display. */
function extensionFor(mimeType: string): string {
  const sub = mimeType.split(";")[0]!.trim().toLowerCase().split("/")[1] ?? "";
  if (sub === "jpeg") return "jpg";
  if (sub === "mpeg") return "mp3";
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : "bin";
}

function parseMediaRef(kind: string, message: Json): CloudMediaRef | null {
  if (!(MEDIA_KINDS as readonly string[]).includes(kind)) return null;
  const block = asObject(message[kind]);
  const id = str(block?.id).trim();
  if (!id) return null;
  const mediaKind = kind as WhatsappMediaKind;
  const mimeType = str(block?.mime_type).trim();
  const given = str(block?.filename).trim();
  const filename = given
    ? capFilename(given)
    : `${SYNTH_STEM[mediaKind]}.${extensionFor(mimeType)}`;
  return { kind: mediaKind, id, mimeType, filename };
}

/**
 * Pulls EVERY inbound customer message, from every entry and change. A
 * message whose block has no routing id, sender or message id is skipped.
 *
 * Non-text messages are kept rather than dropped: an image with a caption is a
 * real message, and even a caption-less one opens the 24-hour service window,
 * which is the fact the send path depends on. So the body may be empty, but
 * the message is never silently discarded.
 *
 * A button tap is a reply: its text becomes the body, so a workflow waiting
 * on a reply can branch on `reply.text` exactly as it does on typed text.
 * Meta sends two shapes — `type: "button"` for a template quick reply
 * (`button.text` / `button.payload`) and `type: "interactive"` for a reply to
 * an in-window interactive message (`button_reply.title` / `button_reply.id`).
 */
export function parseCloudInbounds(payload: unknown): CloudInbound[] {
  const out: CloudInbound[] = [];
  for (const value of allValues(payload)) {
    const phoneNumberId = phoneNumberIdOf(value);
    if (!phoneNumberId) continue;
    for (const raw of asArray(value.messages)) {
      const message = asObject(raw);
      const inbound = message && parseMessage(value, message, phoneNumberId);
      if (inbound) out.push(inbound);
    }
  }
  return out;
}

function parseMessage(
  value: Json,
  message: Json,
  phoneNumberId: string,
): CloudInbound | null {
  const fromPhone =
    typeof message.from === "string" ? message.from.trim() : "";
  const providerMessageId =
    typeof message.id === "string" ? message.id.trim() : "";
  if (!fromPhone || !providerMessageId) return null;

  // The sender's profile is the `contacts[]` entry whose wa_id is this
  // sender; a batch from several customers carries one entry each.
  const contacts = asArray(value.contacts).map(asObject);
  const contact =
    contacts.find((c) => str(c?.wa_id) === fromPhone) ?? contacts[0];
  const profile = asObject(contact?.profile);
  const profileName =
    typeof profile?.name === "string" ? profile.name.trim() : "";

  let text = "";
  let buttonPayload: string | null = null;
  const kind = str(message.type);
  const body = asObject(message.text)?.body;
  if (typeof body === "string") {
    text = body;
  } else if (kind === "button") {
    const button = asObject(message.button);
    text = str(button?.text);
    buttonPayload = str(button?.payload) || null;
  } else if (kind === "interactive") {
    const reply = asObject(asObject(message.interactive)?.button_reply);
    text = str(reply?.title);
    buttonPayload = str(reply?.id) || null;
  } else {
    // Media types nest an optional caption under their own type key.
    const caption = asObject(message[kind])?.caption;
    if (typeof caption === "string") text = caption;
  }

  // Meta: `location: { latitude, longitude, name?, address?, url? }`. No
  // caption field, so `text` stays empty and the AI gate skips it.
  const location =
    kind === "location" ? parseWhatsappLocation(message.location) : null;

  return {
    phoneNumberId,
    fromPhone,
    text,
    providerMessageId,
    profileName,
    buttonPayload,
    media: parseMediaRef(kind, message),
    location,
    locationRejected: kind === "location" && location === null,
    timestampMs: timestampMs(message.timestamp),
  };
}

export interface CloudStatus {
  providerMessageId: string;
  status: string;
  /** The receiving number's Meta id from this receipt's own `value` block —
   *  the routing key, as for inbound messages. */
  phoneNumberId?: string;
  /** The customer's number, bare digits as Meta sends it. */
  recipientId?: string;
  /** First entry of `errors` on a failed receipt (e.g. 131047). */
  errorCode?: string;
  errorTitle?: string;
  /** When Meta recorded the status — its `timestamp` — in ms. */
  timestampMs?: number;
}

/** Delivery receipts. Partial entries are dropped — a status with no message
 *  id cannot be matched to a row, and a row with no status is meaningless. */
export function parseCloudStatuses(payload: unknown): CloudStatus[] {
  const out: CloudStatus[] = [];
  for (const value of allValues(payload)) {
    for (const raw of asArray(value.statuses)) {
      const s = asObject(raw);
      const id = typeof s?.id === "string" ? s.id.trim() : "";
      const status = typeof s?.status === "string" ? s.status.trim() : "";
      if (!id || !status) continue;
      const err = asObject(asArray(s?.errors)[0]);
      const code = err?.code;
      out.push({
        providerMessageId: id,
        status,
        phoneNumberId: phoneNumberIdOf(value) || undefined,
        recipientId: str(s?.recipient_id) || undefined,
        errorCode:
          typeof code === "number" || typeof code === "string" ? String(code) : undefined,
        errorTitle: str(err?.title) || undefined,
        timestampMs: timestampMs(s?.timestamp) ?? undefined,
      });
    }
  }
  return out;
}
