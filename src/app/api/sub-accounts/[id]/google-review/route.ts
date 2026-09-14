import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  DEFAULT_REVIEW_COOLDOWN_DAYS,
  DEFAULT_REVIEW_SMS_TEMPLATE,
  normalizeReviewChannel,
  parseReminderSettings,
} from "@/lib/reviews/constants";
import { isGoogleReviewUrl, isHttpsUrl } from "@/lib/reviews/review-url";
import { reviewTrackingAvailable } from "@/lib/reviews/click-token";
import { isTemplateApprovedFor } from "@/lib/comms/whatsapp/template-registrations";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import { whatsappSenderConfigured } from "@/lib/comms/whatsapp/sender-configured";
import { capabilitiesFor } from "@/lib/comms/whatsapp/provider";
import type { SubAccountDoc } from "@/types";
import type { GoogleReviewConfig } from "@/types/tenancy";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";

/**
 * Manage the per-sub-account Google review-request config.
 *
 * POST — save the config. Admin-only. Server-side validation mirrors the UI
 *   gating so a client can't bypass it: https review URL, SMS body must contain
 *   {{reviewUrl}}, and a WhatsApp channel requires the agency WhatsApp gate ON +
 *   a configured sender + an APPROVED template.
 * PATCH — change only `reminder` (SP5 d2). Admin-only; needs a saved config.
 *   POST keeps the stored reminder when its body has no `reminder` key, so the
 *   Messaging form (which never sends one) can't switch reminders off.
 * DELETE — clear the config.
 */

interface PostBody {
  enabled?: boolean;
  reviewUrl?: string;
  channel?: "sms" | "whatsapp_template" | "whatsapp_manual";
  messageTemplate?: string;
  whatsappTemplateId?: string | null;
  cooldownDays?: number;
  triggerOnQuotePaid?: boolean;
  triggerOnDealCompleted?: boolean;
  reminder?: unknown;
}

const invalidReminder = () =>
  NextResponse.json(
    { error: "Reminders repeat every 1–7 days, at most 5 times.", code: "invalid_reminder", field: "reminder" },
    { status: 400 },
  );

/**
 * What turning reminders ON needs (SP5 d2), or the refusal. SMS only: a
 * template's link can't be tracked (so it can't stop on a click) and repeats
 * an identical template, and an in-window WhatsApp dies at the 24h window.
 * A tracked link, so a click can stop them. A Google review link, so a
 * reminder can only ever send people there. Switching OFF needs none of it.
 */
function reminderRefusal(channel: string, reviewUrl: string): NextResponse | null {
  const refuse = (code: string, error: string) =>
    NextResponse.json({ error, code, field: "reminder" }, { status: 400 });
  if (channel !== "sms") {
    return refuse("reminders_sms_only", "Reminders are for SMS review requests only — switch the channel to SMS first.");
  }
  if (!reviewTrackingAvailable()) {
    return refuse(
      "reminders_need_tracking",
      "Reminders need link tracking, which isn't set up on this deployment (AUTOMATIONS_TOKEN_SECRET and NEXT_PUBLIC_APP_URL).",
    );
  }
  if (!isGoogleReviewUrl(reviewUrl)) {
    return refuse("reminders_google_link_only", "Reminders only repeat a Google review link (g.page, search.google.com, maps.app.goo.gl, google.com).");
  }
  return null;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reminder = body.reminder === undefined ? undefined : parseReminderSettings(body.reminder);
  if (reminder === null) return invalidReminder();

  const reviewUrl = body.reviewUrl?.trim() ?? "";
  if (!reviewUrl || !isHttpsUrl(reviewUrl)) {
    return NextResponse.json(
      { error: "Enter a valid https Google review link." },
      { status: 400 },
    );
  }

  const channel = normalizeReviewChannel(body.channel);
  const isWhatsapp = channel !== "sms";
  if (reminder?.everyDays) {
    const refusal = reminderRefusal(channel, reviewUrl);
    if (refusal) return refusal;
  }
  const messageTemplate =
    body.messageTemplate?.trim() || DEFAULT_REVIEW_SMS_TEMPLATE;

  // Free-form modes (sms + whatsapp_manual) put the link in the body.
  if (channel !== "whatsapp_template" && !messageTemplate.includes("{{reviewUrl}}")) {
    return NextResponse.json(
      { error: "The message must include {{reviewUrl}} so the link is sent." },
      { status: 400 },
    );
  }

  let whatsappTemplateId: string | null = null;
  if (isWhatsapp) {
    // Tie into the agency-level WhatsApp activation: the gate must be ON and a
    // sender configured for EITHER WhatsApp mode. (The UI greys these out
    // without them; enforced here too so it can't be bypassed and so a save is
    // refused if the agency later turns WhatsApp off.)
    const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
    if (sub?.whatsappEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "WhatsApp is disabled for this sub-account by your agency. Ask the agency owner to enable WhatsApp first.",
        },
        { status: 403 },
      );
    }
    // One resolution for the whole route — the rail of the sender this
    // workspace sends on. The approval check below reads the same value, so a
    // config that saves is a config that can send.
    const resolvedSender = resolveWhatsappSender(sub);
    const rail = resolvedSender.ok ? resolvedSender.provider : "twilio";
    // The PURE sender check, deliberately NOT checkWhatsappReadiness: this is a
    // config SAVE, and readiness does a live bridge probe. Refusing to save a
    // configuration because the bridge happens to be unreachable right now
    // would be wrong — health belongs on the send path, which re-checks every
    // time. This only asks whether a sender has been connected at all, on the
    // rail this workspace actually sends over.
    if (!whatsappSenderConfigured(sub)) {
      return NextResponse.json(
        {
          error:
            rail === "twilio"
              ? "Add a WhatsApp sender under Settings → SMS before using WhatsApp for review requests."
              : "Connect this workspace's WhatsApp sender under Settings → WhatsApp before using WhatsApp for review requests.",
        },
        { status: 400 },
      );
    }
    // Saving a template config on a rail with no templates configures a send
    // that can never run — refuse it here rather than at 3am on a trigger.
    if (channel === "whatsapp_template" && !capabilitiesFor(rail).supportsTemplates) {
      return NextResponse.json(
        {
          error: `This workspace's ${rail} WhatsApp rail can't send templates. Use the in-window WhatsApp message or SMS for review requests.`,
        },
        { status: 400 },
      );
    }

    // Only the TEMPLATE mode needs an approved template. Manual mode is
    // free-form (in-window) and carries no template.
    if (channel === "whatsapp_template") {
      whatsappTemplateId = body.whatsappTemplateId?.trim() || null;
      if (!whatsappTemplateId) {
        return NextResponse.json(
          { error: "Pick an approved WhatsApp template for review requests." },
          { status: 400 },
        );
      }
      const tplSnap = await getAdminDb()
        .doc(`subAccounts/${subAccountId}/whatsappTemplates/${whatsappTemplateId}`)
        .get();
      const tpl = tplSnap.exists ? (tplSnap.data() as WhatsappTemplateDoc) : null;
      // Per-rail: after a cloud submission the flat contentSid can still hold a
      // stale Twilio id while the flat status mirrors the cloud approval, so
      // the old check would accept a template approved on a rail this
      // workspace does not send on.
      if (!isTemplateApprovedFor(tpl, rail)) {
        return NextResponse.json(
          {
            error: `That WhatsApp template isn't approved on this workspace's ${rail} WhatsApp rail — only a template approved there can be used.`,
          },
          { status: 400 },
        );
      }
    }
  }

  const cooldownDays = clampCooldown(body.cooldownDays);

  const cfg: GoogleReviewConfig = {
    enabled: body.enabled === true,
    reviewUrl,
    channel,
    messageTemplate,
    whatsappTemplateId,
    cooldownDays,
    triggerOnQuotePaid: body.triggerOnQuotePaid === true,
    triggerOnDealCompleted: body.triggerOnDealCompleted === true,
    // Not in the body → no key here, and the merge below keeps a stored one.
    ...(reminder ? { reminder } : {}),
    updatedAt: new Date(),
  };

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      { googleReviewConfig: cfg, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { reminder?: unknown };
  try {
    body = (await request.json()) as { reminder?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const reminder = parseReminderSettings(body.reminder);
  if (!reminder) return invalidReminder();

  const ref = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const current = ((await ref.get()).data() as SubAccountDoc | undefined)?.googleReviewConfig;
  if (!current?.reviewUrl) {
    return NextResponse.json({ error: "Save your review link first." }, { status: 400 });
  }
  if (reminder.everyDays) {
    const refusal = reminderRefusal(normalizeReviewChannel(current.channel), current.reviewUrl);
    if (refusal) return refusal;
  }
  // Field paths: only these two change — never a write-back of the config read above.
  await ref.update({
    "googleReviewConfig.reminder": reminder,
    "googleReviewConfig.updatedAt": new Date(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true, reminder });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      { googleReviewConfig: null, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

  return NextResponse.json({ ok: true });
}

function clampCooldown(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return DEFAULT_REVIEW_COOLDOWN_DAYS;
  }
  return Math.max(0, Math.min(3650, Math.round(v)));
}
