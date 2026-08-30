import "server-only";

import {
  createDelivery,
  createEvent,
  updateDelivery,
} from "@/lib/firestore/webhook-events";
import {
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
} from "@/lib/firestore/webhook-subscriptions";
import { signWebhookPayload } from "@/lib/api/webhooks/signing";
import { LATEST_API_VERSION } from "@/lib/api/versions";
import { SAMPLE_PAYLOADS } from "@/lib/webhooks/sample-payloads";
import type {
  WebhookEventType,
  WebhookSubscriptionDoc,
} from "@/types/webhooks";

/**
 * Send ONE synchronous test delivery to a subscription and report the
 * outcome immediately — unlike the QStash pipeline (fire-and-forget, result
 * lands in the log seconds later), this awaits the subscriber's HTTP
 * response so the caller can tell the operator "your endpoint answered 200"
 * in the same breath as "webhook created".
 *
 * Used by the AI Suite's create_webhook capability for its liveness check.
 * The event + delivery rows are recorded exactly like the async path, so
 * the test shows up in Logs → Webhooks; there is deliberately NO retry —
 * a failed liveness check is a message to the operator, not a queue item.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_EXCERPT_LIMIT = 2048;

export interface DirectTestResult {
  ok: boolean;
  /** HTTP status the endpoint returned; null on network error/timeout. */
  httpStatus: number | null;
  /** Short failure reason when !ok. */
  error?: string;
  /** Event type that was sent. */
  type: WebhookEventType;
}

export async function sendDirectTestDelivery(
  subscription: WebhookSubscriptionDoc,
  typeOverride?: WebhookEventType,
): Promise<DirectTestResult> {
  const type: WebhookEventType =
    typeOverride ??
    (subscription.events.length > 0 ? subscription.events[0]! : "contact.created");
  const payload = SAMPLE_PAYLOADS[type]();

  const event = await createEvent({
    subAccountId: subscription.subAccountId,
    agencyId: subscription.agencyId,
    mode: subscription.mode,
    type,
    payload,
    subscriptionIds: [subscription.id],
  });
  const delivery = await createDelivery({
    subAccountId: subscription.subAccountId,
    agencyId: subscription.agencyId,
    eventId: event.id,
    subscriptionId: subscription.id,
    attempt: 1,
    url: subscription.url,
    scheduledAt: new Date(),
  });

  const envelope = {
    id: event.id,
    type,
    api_version: LATEST_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: subscription.mode === "live",
    data: payload,
    delivery: { id: delivery.id, attempt: 1 },
  };
  const envelopeJson = JSON.stringify(envelope);
  const signed = signWebhookPayload(subscription.signingSecret, envelopeJson);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let outcome:
    | { kind: "success"; status: number; bodyExcerpt: string }
    | { kind: "failure"; status: number | null; message: string };
  try {
    const res = await fetch(subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "LeadStack-Webhooks/1.0",
        "LeadStack-Signature": signed.header,
        "LeadStack-Version": LATEST_API_VERSION,
        "Webhook-Event-Id": event.id,
        "Webhook-Event-Type": type,
      },
      body: envelopeJson,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const text = await res.text().catch(() => "");
    const bodyExcerpt = text.slice(0, RESPONSE_EXCERPT_LIMIT);
    outcome =
      res.status >= 200 && res.status < 300
        ? { kind: "success", status: res.status, bodyExcerpt }
        : {
            kind: "failure",
            status: res.status,
            message: `Non-2xx response: ${res.status}`,
          };
  } catch (err) {
    clearTimeout(timeoutId);
    outcome = {
      kind: "failure",
      status: null,
      message:
        err instanceof Error
          ? err.name === "AbortError"
            ? `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
            : err.message
          : "Unknown delivery error",
    };
  }

  const attemptedAt = new Date();
  if (outcome.kind === "success") {
    await updateDelivery(subscription.subAccountId, event.id, delivery.id, {
      status: "succeeded",
      httpStatus: outcome.status,
      responseBody: outcome.bodyExcerpt,
      attemptedAt,
    });
    await recordSubscriptionSuccess(
      subscription.subAccountId,
      subscription.id,
      outcome.status,
    );
    return { ok: true, httpStatus: outcome.status, type };
  }

  await updateDelivery(subscription.subAccountId, event.id, delivery.id, {
    status: "failed",
    httpStatus: outcome.status,
    errorMessage: outcome.message,
    attemptedAt,
  });
  await recordSubscriptionFailure(subscription.subAccountId, subscription.id, {
    httpStatus: outcome.status,
    errorMessage: outcome.message,
  });
  return { ok: false, httpStatus: outcome.status, error: outcome.message, type };
}
