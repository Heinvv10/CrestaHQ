import "server-only";

import { NextResponse } from "next/server";
import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { reviewTrackingAvailable } from "@/lib/reviews/click-token";
import { isGoogleReviewUrl } from "@/lib/reviews/review-url";
import type { SubAccountDoc } from "@/types";

/** Review-request reminders (SP5 d2): what turning them on needs, as the config routes' refusals. */

const refuse = (code: string, error: string) => NextResponse.json({ error, code, field: "reminder" }, { status: 400 });

/**
 * What turning reminders ON needs (SP5 d2), or the refusal. SMS only: a
 * template's link can't be tracked (so it can't stop on a click) and repeats
 * an identical template, and an in-window WhatsApp dies at the 24h window.
 * A dedicated SMS number: on the shared sender inbound SMS isn't stored, so a
 * reply ("please stop") could never stop them. A tracked link, so a click can
 * stop them. A Google review link, so a reminder can only ever send people
 * there. Switching OFF needs none of it.
 */
export function reminderRefusal(channel: string, reviewUrl: string, sub: SubAccountDoc | null): NextResponse | null {
  if (channel !== "sms") {
    return refuse("reminders_sms_only", "Reminders are for SMS review requests only — switch the channel to SMS first.");
  }
  if (!subAccountTwilioIsConfigured(sub?.twilioConfig)) {
    return refuse(
      "reminders_need_dedicated_number",
      "Reminders need this sub-account's own SMS number (Settings → SMS): on the shared number customers' replies can't be seen, so a reply couldn't stop them.",
    );
  }
  if (sub?.twilioConfig?.inboundWebhookConfigured !== true) {
    return refuse(
      "reminders_need_inbound_webhook",
      "Reminders need this number's incoming-message webhook set up (Settings → SMS), so a customer's reply reaches you and stops them.",
    );
  }
  if (!reviewTrackingAvailable()) {
    return refuse(
      "reminders_need_tracking",
      "Reminders need link tracking, which isn't set up on this deployment (AUTOMATIONS_TOKEN_SECRET and NEXT_PUBLIC_APP_URL).",
    );
  }
  return googleLinkRefusal(reviewUrl);
}

/** While reminders are on, the review link must stay a Google review link. Shared with adopt-listing-url. */
export function googleLinkRefusal(reviewUrl: string): NextResponse | null {
  return isGoogleReviewUrl(reviewUrl)
    ? null
    : refuse(
        "reminders_google_link_only",
        "Reminders only repeat a Google review link (g.page, search.google.com, maps.app.goo.gl, google.com). Use a Google link, or turn reminders off first.",
      );
}

