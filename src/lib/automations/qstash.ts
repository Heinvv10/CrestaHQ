import "server-only";

import { Client, Receiver } from "@upstash/qstash";

/**
 * QStash thin wrapper. Two roles:
 *   1. publishCallback() — schedules a future POST against any app path (used
 *      by the workflow engine, broadcasts, social planner, and website poll).
 *   2. verifyQStashSignature() — wraps Upstash's Receiver to validate the
 *      Upstash-Signature header on inbound callback POSTs.
 *
 * If QStash isn't configured (no QSTASH_TOKEN), publishCallback returns null
 * and the caller logs a graceful warning. That keeps local dev workable
 * without live QStash credentials, at the cost of scheduled work not firing.
 */

let _client: Client | null = null;
let _receiver: Receiver | null = null;
let _legacyReceiver: Receiver | null = null;
let _legacyHalfWarned = false;

function getClient(): Client | null {
  if (!process.env.QSTASH_TOKEN) return null;
  if (!_client) {
    // QSTASH_URL is region-specific (eu-central-1.upstash.io vs
    // us-east-1.upstash.io). The SDK default may not match the token's
    // region, so we pass it explicitly when set.
    const baseUrl = process.env.QSTASH_URL;
    _client = new Client({
      token: process.env.QSTASH_TOKEN,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  return _client;
}

function getReceiver(): Receiver | null {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current || !next) return null;
  if (!_receiver) {
    _receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    });
  }
  return _receiver;
}

/**
 * The OLD QStash account's signing keys, kept only while its delayed messages
 * (up to ~7 days out) drain after production moves to a new account. Both keys
 * must be set; one alone is ignored.
 */
function getLegacyReceiver(): Receiver | null {
  // Trimmed like the health check and env schema: whitespace-only = unset.
  const current = process.env.QSTASH_LEGACY_CURRENT_SIGNING_KEY?.trim();
  const next = process.env.QSTASH_LEGACY_NEXT_SIGNING_KEY?.trim();
  if (!current || !next) {
    if ((current || next) && !_legacyHalfWarned) {
      _legacyHalfWarned = true;
      console.warn(
        "[qstash] only one of QSTASH_LEGACY_CURRENT_SIGNING_KEY / QSTASH_LEGACY_NEXT_SIGNING_KEY is set; legacy signature verification is off",
      );
    }
    return null;
  }
  if (!_legacyReceiver) {
    _legacyReceiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    });
  }
  return _legacyReceiver;
}

async function verifyWith(
  receiver: Receiver,
  signature: string,
  body: string,
  url?: string,
): Promise<boolean> {
  try {
    return await receiver.verify(url ? { signature, body, url } : { signature, body });
  } catch {
    return false;
  }
}

export function qstashIsConfigured(): boolean {
  return !!getClient() && !!getReceiver();
}

interface PublishCallbackInput {
  /** Path on our app, e.g. "/api/automations/step" — gets appended to NEXT_PUBLIC_APP_URL. */
  pathname: string;
  /** Body POSTed to the callback. */
  body: Record<string, unknown>;
  /** Seconds to defer before the callback fires. 0 = fire immediately. */
  delaySeconds: number;
  /** QStash dedup id — underscores only, no colons. Reschedules pass a nonce-suffixed id. */
  deduplicationId: string;
  /** QStash delivery retries. Absent = QStash's default. */
  retries?: number;
}

interface PublishCallbackResult {
  messageId: string;
}

/**
 * Generic QStash publish helper — schedules a POST against any path on our
 * app. Used by the workflow engine, broadcasts, social planner, and the
 * website poll loop.
 *
 * Returns null if QStash isn't configured or the publish failed; callers
 * decide what to do (typically: mark the work item failed).
 */
export async function publishCallback(
  input: PublishCallbackInput,
): Promise<PublishCallbackResult | null> {
  const client = getClient();
  if (!client) return null;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    console.error("[qstash] NEXT_PUBLIC_APP_URL not set");
    return null;
  }

  try {
    const res = await client.publishJSON({
      url: `${baseUrl}${input.pathname}`,
      body: input.body,
      delay: Math.max(0, Math.floor(input.delaySeconds)),
      deduplicationId: input.deduplicationId,
      ...(input.retries === undefined ? {} : { retries: input.retries }),
    });
    return { messageId: res.messageId };
  } catch (err) {
    console.error("[qstash] publishCallback failed", err);
    return null;
  }
}

interface PublishSocialPostInput {
  postId: string;
  subAccountId: string;
  /** Seconds to defer before publishing. 0 = publish immediately. */
  delaySeconds: number;
}

/**
 * Schedule a Social Planner post to publish at its scheduled time. Thin
 * wrapper over publishCallback against /api/social/publish/step. The dedup id
 * is namespaced (`social_<postId>`) so it can't collide with automation /
 * broadcast dedup ids, and a re-publish of the same post collapses inside the
 * dedup window.
 */
export async function publishSocialPost(
  input: PublishSocialPostInput,
): Promise<PublishCallbackResult | null> {
  return publishCallback({
    pathname: "/api/social/publish/step",
    body: { postId: input.postId, subAccountId: input.subAccountId },
    delaySeconds: input.delaySeconds,
    deduplicationId: `social_${input.postId}`,
  });
}

/**
 * Verify an inbound QStash callback's signature. Returns true if the body
 * matches the Upstash-Signature header. With `url`, the signature must also
 * have been minted for exactly that destination (the JWT `sub`), so a signed
 * call meant for another route cannot be replayed here. A call the primary
 * keys refuse is retried against the optional legacy pair (an old account's
 * still-queued deliveries), under the same `url` binding.
 */
export async function verifyQStashSignature(
  signature: string,
  body: string,
  url?: string,
): Promise<boolean> {
  const receiver = getReceiver();
  if (!receiver) return false;
  if (await verifyWith(receiver, signature, body, url)) return true;
  const legacy = getLegacyReceiver();
  return legacy ? verifyWith(legacy, signature, body, url) : false;
}
