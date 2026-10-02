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
    // The flat fields stop being Twilio's once another rail has written them:
    // a cloud submission mirrors its status into `status`, and freezes a real
    // Twilio registration into the map first only when there was a Content
    // SID to freeze. So no Content SID beside another rail's registration
    // means Twilio never registered this template.
    const otherRail = Object.entries(tpl.registrations ?? {}).some(
      ([p, r]) => p !== "twilio" && !!r,
    );
    if (otherRail && tpl.contentSid == null) return null;
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


/**
 * Firestore field map for recording a submission/approval result on ONE rail.
 *
 * The awkward part is the flat fields. `contentSid`/`status`/`rejectionReason`
 * are simultaneously (a) the Twilio registration for every template predating
 * the provider seam and (b) what the shipped templates-manager UI renders. The
 * moment a cloud submission mirrors its status into `status` so the UI shows
 * something sensible, reading the flat fields as Twilio's registration would
 * report the CLOUD rail's approval as Twilio's.
 *
 * So a cloud write first FREEZES the legacy values into `registrations.twilio`
 * — where the reader prefers them over the flat fallback — and only then
 * mirrors. After that migration the flat fields are presentation only. It
 * happens once per template, lazily, on the first cloud submission, and never
 * overwrites an explicit registration that already exists.
 */
export function buildRegistrationUpdate(
  tpl: RegistrationBearingTemplate | null | undefined,
  provider: WhatsAppProviderId,
  reg: WhatsappTemplateRegistration,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    [`registrations.${provider}`]: reg,
    // Mirror for the existing UI, which renders the flat status.
    status: reg.status,
    rejectionReason: reg.rejectionReason,
  };

  if (provider === "twilio") {
    // Twilio's own routes still read contentSid — keep them authoritative.
    update.contentSid = reg.externalId;
    return update;
  }

  const legacySid = tpl?.contentSid?.trim();
  if (legacySid && !tpl?.registrations?.twilio) {
    update["registrations.twilio"] = {
      externalId: legacySid,
      status: tpl?.status ?? "draft",
      rejectionReason: tpl?.rejectionReason ?? null,
      approvedAt: tpl?.approvedAt ?? null,
    } satisfies WhatsappTemplateRegistration;
  }

  return update;
}


/**
 * What an approval-poll tick should do, given the template's current state and
 * the rail the workspace is on NOW (which may differ from the rail the tick
 * was scheduled for).
 *
 *   "proceed"      — this tick still owns the approval; go ask the provider.
 *   "rail-switched" — the id belongs to a rail the workspace has since left.
 *   "stale"        — superseded by a newer submission, or already settled.
 *
 * The distinction matters because `pending` is a trap: the submit route
 * accepts only draft/rejected/failed and the delete route refuses pending, so
 * a template left pending with no live poll chain cannot be recovered from the
 * UI at all. Treating a rail switch as an ordinary stale tick strands it there
 * permanently.
 */
export function classifyPollTick(
  tpl: RegistrationBearingTemplate | null | undefined,
  provider: WhatsAppProviderId,
  externalId: string,
): "proceed" | "rail-switched" | "stale" {
  if (!tpl || tpl.status !== "pending") return "stale";
  if (templateRegistration(tpl, provider)?.externalId === externalId) {
    return "proceed";
  }
  // The `p !== provider` term is belt-and-braces: the active rail was already
  // matched above, so it can never match here. Kept so the intent survives a
  // future edit to the check above.
  const heldByAnotherRail = (
    ["twilio", "cloud", "bridge"] as const
  ).some(
    (p) =>
      p !== provider && templateRegistration(tpl, p)?.externalId === externalId,
  );
  return heldByAnotherRail ? "rail-switched" : "stale";
}
