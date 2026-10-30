import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend signs its webhooks with Svix: `svix-signature` lists one or more
 * `v1,<base64 HMAC-SHA256>` over `${svix-id}.${svix-timestamp}.${raw body}`,
 * keyed with the base64 part of the `whsec_…` signing secret. Verified here
 * by hand (no svix dependency) — timing-safe, with a ±5 minute timestamp
 * window; a replay of a still-fresh message is acknowledged by the route
 * without being processed again.
 */

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

/** Svix message ids are `msg_…`; the pattern also makes it a safe doc id. */
const SVIX_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SVIX_TIMESTAMP = /^\d{1,12}$/;
/** A handful of space-separated signatures (one per active secret). */
const MAX_SIGNATURE_HEADER = 2048;

/**
 * The HMAC key from RESEND_WEBHOOK_SECRET, or null when it is unset or not
 * a `whsec_<base64>` secret of at least 16 bytes — the route then refuses
 * every request.
 */
export function resendWebhookKey(secret = process.env.RESEND_WEBHOOK_SECRET): Buffer | null {
  const trimmed = secret?.trim() ?? "";
  if (!trimmed.startsWith("whsec_")) return null;
  const b64 = trimmed.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const key = Buffer.from(b64, "base64");
  return key.length >= 16 ? key : null;
}

/** The svix-id when the request is signed with `key` and fresh, else null. */
export function verifySvixRequest(input: {
  key: Buffer;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs: number;
}): string | null {
  const { key, id, timestamp, signature, body } = input;
  if (!id || !SVIX_ID.test(id)) return null;
  if (!timestamp || !SVIX_TIMESTAMP.test(timestamp)) return null;
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > SVIX_TOLERANCE_SECONDS) return null;
  if (!signature || signature.length > MAX_SIGNATURE_HEADER) return null;

  const expected = Buffer.from(
    createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64"),
    "utf8",
  );
  let valid = false;
  for (const entry of signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const presented = Buffer.from(entry.slice(comma + 1), "utf8");
    // No early exit: every listed signature is compared.
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) valid = true;
  }
  return valid ? id : null;
}
