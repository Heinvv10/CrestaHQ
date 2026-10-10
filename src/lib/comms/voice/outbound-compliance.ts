import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { parsePhoneNumberFromString } from "libphonenumber-js";

import { getAdminDb } from "@/lib/firebase/admin";
import { checkQuota } from "@/lib/server/usage-meter";
import { computeWindowDeferralSeconds } from "@/lib/time/window";
import {
  timezoneForPhone,
  countryForPhone,
} from "@/lib/contacts/phone-timezone";
import { getComplianceProvider } from "./compliance-provider";
import type { Contact } from "@/types/contacts";
import type { VoiceChannelConfig } from "@/types/ai";

/**
 * Native outbound-call compliance gate. Enforces — with NO third-party
 * dependency — everything LeadStack can verify itself before an AI call
 * is placed: a valid number, voice opt-out, per-call consent, the
 * calling window in the contact's own timezone, an optional country
 * allow-list, and rate / daily / per-number frequency caps. A pluggable
 * scrub provider (no-op by default) runs last for buyers who add a
 * regional service. First failing check blocks — the call is never
 * placed, so no Vapi minutes are spent.
 */

export type OutboundComplianceCode =
  | "no_phone"
  | "opted_out"
  | "no_consent"
  | "country_blocked"
  | "outside_window"
  | "daily_cap"
  | "number_frequency"
  | "rate_limited"
  | "scrub_blocked"
  // Monthly voice-minutes quota reached (Usage Metering v1).
  | "quota";

export interface OutboundComplianceResult {
  allowed: boolean;
  code?: OutboundComplianceCode;
  reason?: string;
  retryAfterSec?: number;
  /** Normalized E.164 number, set once the phone parses. */
  e164?: string;
}

// Per-sub-account per-minute burst limiter (in-memory sliding window).
// Same caveat as the other in-memory limiters in this codebase: it's
// per-instance and resets on cold start. The Firestore daily cap is the
// durable backstop; this only smooths bursts.
const burstHits = new Map<string, number[]>();
function consumeBurstSlot(subAccountId: string, perMinuteCap: number): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  const arr = (burstHits.get(subAccountId) ?? []).filter((t) => t > cutoff);
  if (arr.length >= perMinuteCap) {
    burstHits.set(subAccountId, arr);
    return false;
  }
  arr.push(now);
  burstHits.set(subAccountId, arr);
  return true;
}

/**
 * Check 1 — a number libphonenumber calls valid with NO default region (so in
 * practice written in "+…" international form), normalised to E.164, with its
 * country (null for a non-geographic number such as +882 or +800). Shared with
 * the human browser dialer, which dials only `e164`.
 */
export function validDialNumber(
  phone: string | null | undefined,
): { e164: string; country: string | null } | null {
  const parsed = phone ? parsePhoneNumberFromString(phone) : null;
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, country: parsed.country ?? countryForPhone(parsed.number) };
}

/**
 * Check 4 — the optional country allow-list (null or empty = allow all). A
 * number with no country (non-geographic, e.g. +882) is blocked whenever a
 * list is set. Shared with the human browser dialer.
 */
export function countryBlocked(
  country: string | null,
  allowedCountries: string[] | null | undefined,
): boolean {
  if (!allowedCountries || allowedCountries.length === 0) return false;
  return !country || !allowedCountries.includes(country);
}

export async function checkOutboundCompliance(input: {
  subAccountId: string;
  contact: Contact;
  voice: VoiceChannelConfig;
  /** Agent profile timezone — fallback when the contact's phone country
   *  isn't in our timezone table. */
  agentTimezone: string;
  /** Per-call operator consent acknowledgment (Phase 1 consent model). */
  consentAck: boolean;
}): Promise<OutboundComplianceResult> {
  const { subAccountId, contact, voice, agentTimezone, consentAck } = input;

  // 1. Valid phone
  const dialable = validDialNumber(contact.phone);
  if (!dialable) {
    return {
      allowed: false,
      code: "no_phone",
      reason: "This contact has no valid phone number.",
    };
  }
  const { e164, country } = dialable;

  // 2. Voice opt-out (independent of SMS opt-out)
  if (contact.voiceOptedOut === true) {
    return {
      allowed: false,
      code: "opted_out",
      reason: "This contact has opted out of voice calls.",
      e164,
    };
  }

  // 3. Consent — Phase 1 requires a per-call operator acknowledgment
  if (consentAck !== true) {
    return {
      allowed: false,
      code: "no_consent",
      reason: "Confirm you have consent to call this contact.",
      e164,
    };
  }

  // 3b. Monthly voice-minutes quota (Usage Metering v1) — blocked here
  // spends zero Vapi minutes, consistent with this gate's design. Fails
  // open inside checkQuota.
  const quota = await checkQuota({ subAccountId, unit: "voiceSeconds" });
  if (!quota.allowed) {
    return {
      allowed: false,
      code: "quota",
      reason:
        "This workspace's monthly voice-minutes limit has been reached.",
      e164,
    };
  }

  // 4. Country allow-list (optional; null = allow all)
  if (countryBlocked(country, voice.allowedCountries)) {
    return {
      allowed: false,
      code: "country_blocked",
      reason: `Calls to ${country ?? "this country"} aren't enabled for this workspace.`,
      e164,
    };
  }

  // 5. Calling window — evaluated in the CONTACT's local timezone
  const tz = timezoneForPhone(
    e164,
    voice.outboundWindow?.timezone || agentTimezone,
  );
  const deferral = computeWindowDeferralSeconds(
    voice.outboundWindow
      ? {
          startHour: voice.outboundWindow.startHour,
          endHour: voice.outboundWindow.endHour,
          timezone: tz,
        }
      : null,
  );
  if (deferral > 0) {
    return {
      allowed: false,
      code: "outside_window",
      reason: `It's outside the calling window in the contact's local time (${tz}).`,
      retryAfterSec: deferral,
      e164,
    };
  }

  // 6. Daily cap + per-number frequency (durable — Firestore, rolling 24h)
  try {
    const since = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const snap = await getAdminDb()
      .collection(`subAccounts/${subAccountId}/voiceCalls`)
      .where("direction", "==", "outbound")
      .where("createdAt", ">=", since)
      .get();
    if (snap.size >= voice.outboundDailyCap) {
      return {
        allowed: false,
        code: "daily_cap",
        reason: "Daily outbound call limit reached for this workspace.",
        e164,
      };
    }
    const perNumber = snap.docs.filter(
      (d) => (d.data().callerPhone ?? null) === e164,
    ).length;
    if (perNumber >= voice.outboundPerNumberPerDay) {
      return {
        allowed: false,
        code: "number_frequency",
        reason: "This number has already been called the maximum times in the last 24h.",
        e164,
      };
    }
  } catch (err) {
    // A Firestore blip shouldn't permanently halt calling. Log + continue;
    // the in-memory burst limiter below still applies. Buyers needing
    // fail-closed can tighten this.
    console.error("[outbound-compliance] frequency check failed", err);
  }

  // 7. Burst (per-minute) — consumed last so an earlier rejection doesn't
  //    waste a slot.
  if (!consumeBurstSlot(subAccountId, voice.outboundPerMinuteCap)) {
    return {
      allowed: false,
      code: "rate_limited",
      reason: "Too many calls placed in the last minute — try again shortly.",
      retryAfterSec: 60,
      e164,
    };
  }

  // 8. Pluggable third-party scrub (no-op by default)
  try {
    const scrub = await getComplianceProvider().scrub(e164);
    if (!scrub.allowed) {
      return {
        allowed: false,
        code: "scrub_blocked",
        reason:
          scrub.reasons.join("; ") || "Blocked by compliance screening.",
        e164,
      };
    }
  } catch (err) {
    // Provider outage → allow (the native gate already passed). A buyer
    // who needs fail-closed implements that inside their provider.
    console.error("[outbound-compliance] scrub provider failed", err);
  }

  return { allowed: true, e164 };
}
