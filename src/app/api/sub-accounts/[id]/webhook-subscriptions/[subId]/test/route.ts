import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  createDelivery,
  createEvent,
} from "@/lib/firestore/webhook-events";
import { getSubscription } from "@/lib/firestore/webhook-subscriptions";
import { scheduleDeliveryRetry } from "@/lib/api/webhooks/dispatch";
import { SAMPLE_PAYLOADS } from "@/lib/webhooks/sample-payloads";
import type { WebhookEventType } from "@/types/webhooks";

/**
 * Send a synthetic webhook event to one specific subscription.
 *
 * Stripe-style "Send test event" affordance — lets non-technical
 * agencies verify their Zap / Make / custom endpoint is wired up
 * BEFORE going live. The synthetic envelope flows through the same
 * dispatcher, signing, retry, and delivery-log pipeline as a real
 * event, so what subscribers see in test matches production exactly.
 *
 * Behaviour:
 *   - Picks the event type to fire: caller may pass `?type=<event-type>`
 *     in the body; defaults to the FIRST event-type the subscription is
 *     subscribed to. Falls back to `contact.created` if subscribed to
 *     everything.
 *   - Builds a representative sample payload (see SAMPLE_PAYLOADS below).
 *     Stripe doesn't flag test events with anything special; we follow
 *     that — the visible difference is the realistic-but-obviously-fake
 *     identifier like `contact_test_xxx`.
 *   - Creates the same `webhookEvents/{eventId}` + `deliveries/{deliveryId}`
 *     pair a real event would create. The delivery log shows test events
 *     alongside real ones; the operator can re-trigger from the same UI.
 *
 * Auth: sub-account admin (agency owners count). Same model as the
 * subscription CRUD routes.
 */

interface TestBody {
  type?: WebhookEventType;
}


export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; subId: string }> },
) {
  const { id: subAccountId, subId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const subscription = await getSubscription(subAccountId, subId);
  if (!subscription || subscription.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (subscription.status === "paused") {
    return NextResponse.json(
      {
        error:
          "Subscription is paused. Resume it before sending a test event.",
      },
      { status: 400 },
    );
  }

  let body: TestBody = {};
  try {
    body = (await request.json()) as TestBody;
  } catch {
    // Empty body is fine — we'll pick a sensible default below.
  }

  // Pick the event type to fire:
  //   1. Explicit ?type=... in body (must be one the subscription cares about)
  //   2. First subscribed event type (or contact.created if subscribed to all)
  let type: WebhookEventType;
  if (body.type) {
    if (subscription.events.length > 0 && !subscription.events.includes(body.type)) {
      return NextResponse.json(
        {
          error: `Subscription is not subscribed to '${body.type}'. Add it to the event list first.`,
        },
        { status: 400 },
      );
    }
    type = body.type;
  } else if (subscription.events.length === 0) {
    type = "contact.created";
  } else {
    type = subscription.events[0]!;
  }

  const payload = SAMPLE_PAYLOADS[type]();

  // Persist as a real event + delivery pair so the test shows up in the
  // delivery log alongside real events. Operators can re-trigger from
  // the standard replay flow if they want to debug.
  const event = await createEvent({
    subAccountId,
    agencyId: subscription.agencyId,
    mode: subscription.mode,
    type,
    payload,
    subscriptionIds: [subscription.id],
  });
  const delivery = await createDelivery({
    subAccountId,
    agencyId: subscription.agencyId,
    eventId: event.id,
    subscriptionId: subscription.id,
    attempt: 1,
    url: subscription.url,
    scheduledAt: new Date(),
  });
  await scheduleDeliveryRetry({
    subAccountId,
    eventId: event.id,
    deliveryId: delivery.id,
    delaySeconds: 0,
  });

  return NextResponse.json({
    ok: true,
    eventId: event.id,
    deliveryId: delivery.id,
    type,
    message: `Test event '${type}' dispatched. Check your endpoint within ~10 seconds.`,
  });
}
