import "server-only";

import { NextResponse } from "next/server";
import twilio from "twilio";
import { FieldPath } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import { readSubAccountSecret } from "@/lib/server/sub-account-secrets";
import type { DialerPrivateDoc, SubAccountDoc } from "@/types";

/**
 * Softphone v1 — server helpers for the outbound browser dialer.
 *
 * The dialer rides the sub-account's OWN Twilio account (the same dedicated
 * creds SMS uses): provisioning mints a Twilio API Key + a TwiML App on that
 * account; the browser gets a short-TTL AccessToken (never the secrets) and
 * dials through the TwiML App, which POSTs our TwiML webhook. Outbound-only —
 * the number's inbound voice handler (Vapi BYOC / MCTB) is never touched.
 *
 * Ours differs from upstream in two places: the agency gate
 * `dialerEnabledByAgency` (upstream has none), and the Twilio auth token,
 * which lives in `private/twilioCredentials` and is read only through
 * `readSubAccountSecret` (upstream read `twilioConfig.authToken`).
 * See docs/features/dialer.md.
 */

const PRIVATE_DOC = "dialer";

export function dialerEnabled(
  sub?: Pick<SubAccountDoc, "dialerConfig"> | null,
): boolean {
  return sub?.dialerConfig?.enabled === true;
}

/** The agency gate. Opt-in: legacy docs without the field read as off. */
export function dialerGateOn(
  sub?: Pick<SubAccountDoc, "dialerEnabledByAgency"> | null,
): boolean {
  return sub?.dialerEnabledByAgency === true;
}

export function dialerGateRefusal(): NextResponse {
  return NextResponse.json(
    {
      error: "The phone dialer is locked by your agency. Ask your agency owner to enable it.",
      code: "gate_off",
    },
    { status: 403 },
  );
}

/**
 * The sub-account's dedicated Twilio creds, token read from the private doc
 * (legacy parent field as fallback). Null when dedicated Twilio isn't fully
 * configured — the dialer has no shared-sender mode.
 */
export async function dialerTwilioCreds(
  subAccountId: string,
  sub: Partial<Pick<SubAccountDoc, "twilioConfig">> | null | undefined,
): Promise<{ accountSid: string; authToken: string; fromNumber: string } | null> {
  const cfg = sub?.twilioConfig;
  if (!cfg || !subAccountTwilioIsConfigured(cfg)) return null;
  const authToken = await readSubAccountSecret(subAccountId, "twilio", cfg);
  if (!authToken) return null;
  return { accountSid: cfg.accountSid, authToken, fromNumber: cfg.fromNumber };
}

/** Just the token, for webhook signature checks. Empty string when unset. */
export async function dialerAuthToken(
  subAccountId: string,
  sub: Partial<Pick<SubAccountDoc, "twilioConfig">> | null | undefined,
): Promise<string> {
  if (!sub?.twilioConfig) return "";
  return readSubAccountSecret(subAccountId, "twilio", sub.twilioConfig);
}

/** Most opted-out contacts the dialer will read for one call before refusing. */
export const VOICE_OPT_OUT_SCAN_CAP = 2000;
const VOICE_OPT_OUT_PAGE = 500;

/**
 * Does an opted-out contact's stored phone name the number about to be
 * dialled? Digits only, no parsing: contacts have no normalised phone field
 * and the stored string may be in any spelling. It blocks when the stored
 * digits equal the target's E.164 digits, or contain the target's national
 * significant number (7+ digits) — which covers a trunk "0", a "00"/"011"
 * prefix, any punctuation, and a trailing extension. It over-blocks (another
 * country's number with the same national digits) by design.
 */
export function optOutCoversNumber(
  storedPhone: unknown,
  target: { e164: string; national: string },
): boolean {
  const digits = typeof storedPhone === "string" ? storedPhone.replace(/\D/g, "") : "";
  if (!digits) return false;
  if (digits === target.e164.replace(/\D/g, "")) return true;
  return target.national.length >= 7 && digits.includes(target.national);
}

/**
 * A voice opt-out belongs to the number, not one contact doc. Reads the
 * sub-account's opted-out contacts (two equality filters, paged by document
 * id — no composite index) and compares each with {@link optOutCoversNumber}.
 * `over_cap` when there are more than {@link VOICE_OPT_OUT_SCAN_CAP} to read
 * and none of the first ones matched: the caller must refuse (fail closed).
 */
export async function numberVoiceOptOut(
  subAccountId: string,
  target: { e164: string; national: string },
): Promise<"clear" | "opted_out" | "over_cap"> {
  const base = getAdminDb()
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("voiceOptedOut", "==", true)
    .select("phone")
    .orderBy(FieldPath.documentId());
  let seen = 0;
  let cursor: string | null = null;
  for (;;) {
    // One past the cap, so "exactly the cap" and "more than the cap" differ.
    const want = Math.min(VOICE_OPT_OUT_PAGE, VOICE_OPT_OUT_SCAN_CAP + 1 - seen);
    const snap = await (cursor ? base.startAfter(cursor) : base).limit(want).get();
    for (const d of snap.docs) {
      if (optOutCoversNumber(d.data().phone, target)) return "opted_out";
    }
    seen += snap.docs.length;
    if (seen > VOICE_OPT_OUT_SCAN_CAP) return "over_cap";
    if (snap.docs.length < want) return "clear";
    cursor = snap.docs[snap.docs.length - 1]!.id;
  }
}

export function dialerPrivateRef(subAccountId: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/private/${PRIVATE_DOC}`);
}

export async function getDialerPrivate(
  subAccountId: string,
): Promise<DialerPrivateDoc | null> {
  const snap = await dialerPrivateRef(subAccountId).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<DialerPrivateDoc>;
  if (!data.apiKeySid || !data.apiKeySecret || !data.twimlAppSid) return null;
  return data as DialerPrivateDoc;
}

/** The TwiML App's voice URL — where Twilio asks "what do I do with this call?". */
export function dialerTwimlUrl(subAccountId: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/dialer/twiml/${subAccountId}`;
}

/** The <Dial action> callback — where the call outcome lands. */
export function dialerStatusUrl(
  subAccountId: string,
  contactId: string,
): string {
  return `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/dialer/status/${subAccountId}?contactId=${encodeURIComponent(contactId)}`;
}

/**
 * Validate a Twilio-signed webhook for the dialer routes. Same reconstruction
 * as the SMS/WhatsApp inbound routes (x-forwarded proto/host + pathname), but
 * KEEPS the query string — the status callback carries `?contactId=…`, and
 * Twilio's signature covers the full URL it was given.
 */
export function validateDialerSignature(input: {
  request: Request;
  authToken: string;
  params: Record<string, string>;
}): boolean {
  const { request, authToken, params } = input;
  if (!authToken) return false;
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return false;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const url = new URL(request.url);
  const fullUrl = `${proto}://${host ?? url.host}${url.pathname}${url.search}`;
  return twilio.validateRequest(authToken, signature, fullUrl, params);
}

/** Twilio AccessToken (JWT) for the browser Device. TTL 1h; identity = uid. */
export function mintDialerToken(input: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
}): string {
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(
    input.accountSid,
    input.apiKeySid,
    input.apiKeySecret,
    { identity: input.identity, ttl: 3600 },
  );
  token.addGrant(
    new AccessToken.VoiceGrant({
      outgoingApplicationSid: input.twimlAppSid,
      incomingAllow: false,
    }),
  );
  return token.toJwt();
}

/** Deterministic activity doc id so the status callback can update the row. */
export function dialerActivityId(callSid: string): string {
  return `dialer_${callSid}`;
}

/** "client:abc123" → "abc123"; anything else → null. */
export function uidFromClientAddress(from: string | undefined): string | null {
  if (!from) return null;
  return from.startsWith("client:") ? from.slice("client:".length) : null;
}

export function formatCallDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
