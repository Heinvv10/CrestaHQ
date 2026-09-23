import "server-only";

import { NextResponse } from "next/server";
import twilio from "twilio";
import { getAdminDb } from "@/lib/firebase/admin";
import { stripWhatsappPrefix } from "@/lib/comms/twilio";
import {
  normalizeDeliveryStatus,
  recordWhatsappDeliveryStatus,
} from "@/lib/comms/whatsapp/delivery-status";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Twilio WhatsApp statusCallback — registered on every WhatsApp send in
 * `@/lib/comms/twilio`. Twilio accepts a create and reports the real outcome
 * here later (63016 outside the window, 30007 filtered…); without it those
 * rows stayed "sent".
 *
 * Routing and signature validation mirror the inbound route exactly, keyed on
 * `From` (our sender) rather than `To`, because on a status callback the
 * customer is the recipient. The row is found by MessageSid under the
 * recipient's contact in the resolved sub-account only.
 *
 * Always 200 except on a bad signature.
 */

const ok = () => new NextResponse(null, { status: 200 });

function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

async function resolveRoute(
  fromNumber: string,
): Promise<{ authToken: string; subAccountId: string } | null> {
  if (!fromNumber) return null;
  const snap = await getAdminDb()
    .collection("subAccounts")
    .where("twilioConfig.whatsappFromNumber", "==", fromNumber)
    .where("twilioConfig.enabled", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const sa = snap.docs[0].data() as SubAccountDoc;
  if (sa.whatsappEnabledByAgency !== true) return null;
  if (!sa.twilioConfig?.authToken) return null;
  return { authToken: sa.twilioConfig.authToken, subAccountId: snap.docs[0].id };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

  const from = normalisePhone(stripWhatsappPrefix(params["From"] ?? ""));
  const to = normalisePhone(stripWhatsappPrefix(params["To"] ?? ""));
  const messageSid = params["MessageSid"] ?? "";

  const route = await resolveRoute(from);
  if (!route) return ok();

  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    console.warn("[twilio/whatsapp/status] missing X-Twilio-Signature header");
    return ok();
  }
  // Twilio signs over the RAW params (with the whatsapp: prefixes).
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const url = new URL(request.url);
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}`;
  if (!twilio.validateRequest(route.authToken, signature, fullUrl, params)) {
    console.warn(
      `[twilio/whatsapp/status] invalid signature (sa=${route.subAccountId})`,
    );
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const status = normalizeDeliveryStatus(params["MessageStatus"] ?? "");
  if (!status || !messageSid) return ok();

  try {
    await recordWhatsappDeliveryStatus({
      db: getAdminDb(),
      subAccountId: route.subAccountId,
      recipientPhone: to,
      providerMessageId: messageSid,
      status,
      errorCode: params["ErrorCode"] || null,
    });
  } catch (err) {
    console.warn(
      `[twilio/whatsapp/status] ${status} not recorded (sa=${route.subAccountId})`,
      err,
    );
  }
  return ok();
}
