/**
 * Per-provider template approval state.
 *
 * A WhatsApp template is approved against a WABA, not against us. The Twilio
 * rail brokers templates through Twilio's Content API on Twilio's WABA; the
 * Cloud rail submits directly to our own. The same logical template is
 * therefore approved on one rail and unknown on the other, and a sub-account
 * mid-cutover legitimately has both states at once.
 *
 * Deliberately ADDITIVE. Today's flat `contentSid` / `status` /
 * `rejectionReason` / `approvedAt` fields on the template doc ARE the Twilio
 * registration — six shipped routes read them, and rewriting those to prove a
 * schema point would risk a working rail for no behavioural gain. The `cloud`
 * (and later `bridge`) registrations live in the optional `registrations` map,
 * and `templateRegistration()` is the single reader that makes the two shapes
 * look alike.
 *
 * The only question the send path ever asks is "is this template approved on
 * the provider I am about to send through" — `isTemplateApprovedFor` answers
 * exactly that and nothing else.
 */

import type { WhatsAppProviderId } from "./provider";
import type { WhatsappTemplateStatus } from "@/types/whatsapp-templates";

export interface WhatsappTemplateRegistration {
  /** Twilio Content SID (HX…) or Meta's template id, depending on the rail. */
  externalId: string | null;
  status: WhatsappTemplateStatus;
  rejectionReason: string | null;
  pollAttempts?: number;
  approvedAt?: unknown;
}

/** The shape this module needs from a template doc — both the legacy flat
 *  fields and the new map, so it can read either. */
export interface RegistrationBearingTemplate {
  contentSid?: string | null;
  status?: WhatsappTemplateStatus;
  rejectionReason?: string | null;
  approvedAt?: unknown;
  registrations?: Partial<
    Record<WhatsAppProviderId, WhatsappTemplateRegistration>
  > | null;
}

export function templateRegistration(
  tpl: RegistrationBearingTemplate | null | undefined,
  provider: WhatsAppProviderId,
): WhatsappTemplateRegistration | null {
  if (!tpl) return null;

  const explicit = tpl.registrations?.[provider];
  if (explicit) return explicit;

  // Legacy fallback for Twilio only. Reading the flat fields for `cloud` would
  // report a Twilio-approved template as sendable on a WABA that has never
  // seen it — the send fails at Meta, out of window, with the customer
  // unreachable. Absent means absent.
  if (provider === "twilio") {
    return {
      externalId: tpl.contentSid ?? null,
      status: tpl.status ?? "draft",
      rejectionReason: tpl.rejectionReason ?? null,
      approvedAt: tpl.approvedAt,
    };
  }

  return null;
}

/**
 * Approved AND carrying the external id the rail needs to actually send. An
 * "approved" registration with no id cannot be sent, so reporting it as
 * approved would push the send path into a template branch it cannot execute.
 */
export function isTemplateApprovedFor(
  tpl: RegistrationBearingTemplate | null | undefined,
  provider: WhatsAppProviderId,
): boolean {
  const reg = templateRegistration(tpl, provider);
  return reg?.status === "approved" && !!reg.externalId?.trim();
}
