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

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Json)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** First `value` block carrying anything we care about. */
function firstValue(payload: unknown): Json | null {
  const root = asObject(payload);
  if (!root) return null;
  for (const entry of asArray(root.entry)) {
    const e = asObject(entry);
    if (!e) continue;
    for (const change of asArray(e.changes)) {
      const c = asObject(change);
      const value = asObject(c?.value);
      if (value) return value;
    }
  }
  return null;
}

/**
 * The recipient number's Meta id — the routing key that says which
 * sub-account this webhook belongs to.
 */
export function parseCloudPhoneNumberId(payload: unknown): string | null {
  const meta = asObject(firstValue(payload)?.metadata);
  const id = meta?.phone_number_id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export interface CloudInbound {
  fromPhone: string;
  text: string;
  providerMessageId: string;
  profileName: string;
}

/**
 * Pulls the first inbound customer message.
 *
 * Non-text messages are kept rather than dropped: an image with a caption is a
 * real message, and even a caption-less one opens the 24-hour service window,
 * which is the fact the send path depends on. So the body may be empty, but
 * the message is never silently discarded.
 */
export function parseCloudInbound(payload: unknown): CloudInbound | null {
  const value = firstValue(payload);
  if (!value) return null;

  const message = asObject(asArray(value.messages)[0]);
  if (!message) return null;

  const fromPhone =
    typeof message.from === "string" ? message.from.trim() : "";
  const providerMessageId =
    typeof message.id === "string" ? message.id.trim() : "";
  if (!fromPhone || !providerMessageId) return null;

  const profile = asObject(asObject(asArray(value.contacts)[0])?.profile);
  const profileName =
    typeof profile?.name === "string" ? profile.name.trim() : "";

  let text = "";
  const body = asObject(message.text)?.body;
  if (typeof body === "string") {
    text = body;
  } else {
    // Media types nest an optional caption under their own type key.
    const kind = typeof message.type === "string" ? message.type : "";
    const caption = asObject(message[kind])?.caption;
    if (typeof caption === "string") text = caption;
  }

  return { fromPhone, text, providerMessageId, profileName };
}

export interface CloudStatus {
  providerMessageId: string;
  status: string;
}

/** Delivery receipts. Partial entries are dropped — a status with no message
 *  id cannot be matched to a row, and a row with no status is meaningless. */
export function parseCloudStatuses(payload: unknown): CloudStatus[] {
  const value = firstValue(payload);
  if (!value) return [];
  const out: CloudStatus[] = [];
  for (const raw of asArray(value.statuses)) {
    const s = asObject(raw);
    const id = typeof s?.id === "string" ? s.id.trim() : "";
    const status = typeof s?.status === "string" ? s.status.trim() : "";
    if (id && status) out.push({ providerMessageId: id, status });
  }
  return out;
}
