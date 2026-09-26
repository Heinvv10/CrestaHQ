import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured } from "@/lib/comms/resend";
import { publishCallback } from "@/lib/automations/qstash";
import { resolveMergeTags, validateEmailBody } from "@/lib/automations/merge-tags";
import { countAudience } from "@/lib/broadcasts/audience";
import { BROADCAST_FANOUT_RETRIES } from "@/lib/broadcasts/completion";
import type { BroadcastAudienceFilter, BroadcastDoc, MessageTemplateDoc } from "@/types";

/**
 * Starting an email broadcast, shared by POST /api/broadcasts/email/send and
 * the agent's create_broadcast: the checks (agency gate, email, the template,
 * the audience size) and the idempotent create + fan-out start.
 */

/** Hard cap on per-broadcast audience size to prevent runaway sends. */
export const MAX_AUDIENCE_SIZE = 25_000;

/** gRPC ALREADY_EXISTS - create() on a doc that is already there. */
const ALREADY_EXISTS = 6;

type Failure = { ok: false; status: number; error: string; broadcastId?: string };

export async function checkBroadcast(opts: {
  subAccountId: string;
  templateId: string;
  audienceFilter: BroadcastAudienceFilter;
  territoryIds: string[] | null;
}): Promise<{ ok: true; template: MessageTemplateDoc; matching: number } | Failure> {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${opts.subAccountId}`).get();
  if (!subSnap.exists) return { ok: false, status: 404, error: "Sub-account not found" };
  if (subSnap.data()?.broadcastsEnabledByAgency !== true) {
    return {
      ok: false,
      status: 403,
      error:
        "Broadcasts are disabled for this sub-account. Your agency administrator can enable them from Manage in the agency sub-accounts list.",
    };
  }
  if (!emailIsConfigured(subSnap.data())) return { ok: false, status: 503, error: "Email is not configured for this sub-account." };
  const templateSnap = await db.collection("message_templates").doc(opts.templateId).get();
  if (!templateSnap.exists) return { ok: false, status: 404, error: "Template not found" };
  const template = templateSnap.data() as MessageTemplateDoc;
  if (template.subAccountId !== opts.subAccountId) return { ok: false, status: 403, error: "Template belongs to a different sub-account" };
  if (template.type !== "email") return { ok: false, status: 400, error: "Template is not an email template" };
  const bodyValidation = validateEmailBody(template.body);
  if (bodyValidation) return { ok: false, status: 400, error: bodyValidation };

  const matching = await countAudience(opts.subAccountId, opts.audienceFilter, opts.territoryIds, MAX_AUDIENCE_SIZE);
  if (matching === 0) return { ok: false, status: 400, error: "Audience is empty \u2014 no contacts match this filter." };
  if (matching > MAX_AUDIENCE_SIZE) {
    return { ok: false, status: 400, error: `Audience size exceeds the per-broadcast cap of ${MAX_AUDIENCE_SIZE}. Narrow the filter and try again.` };
  }
  return { ok: true, template, matching };
}

/**
 * Create the broadcast (idempotent on `idempotencyKey`) and hand its
 * audience to the fan-out step, which pages through it and publishes the
 * staggered per-recipient sends.
 */
export async function startBroadcast(opts: {
  subAccountId: string;
  idempotencyKey: string;
  templateId: string;
  template: MessageTemplateDoc;
  audienceFilter: BroadcastAudienceFilter;
  territoryIds: string[] | null;
  createdByUid: string;
  createdBy: { displayName: string; email: string };
  approved?: BroadcastDoc["approved"];
}): Promise<{ ok: true; broadcastId: string; duplicate: boolean } | Failure> {
  const { subAccountId, templateId, template, audienceFilter, territoryIds } = opts;
  const broadcastRef = getAdminDb().collection("broadcasts").doc(`${subAccountId}_${opts.idempotencyKey}`);
  const broadcast: Omit<BroadcastDoc, "id"> = {
    agencyId: template.agencyId,
    subAccountId,
    channel: "email",
    templateId,
    templateName: template.name,
    subjectPreview: resolveMergeTags((template.subject ?? "").slice(0, 200), {
      contact: { name: "", email: "", phone: "" },
      owner: { displayName: "", email: "" },
      workspace: { name: "" },
      bookingLink: "",
      unsubscribeLink: "",
    }),
    audienceFilter,
    status: "queued",
    totals: { audienceSize: 0, queued: 0, sent: 0, skipped: 0, failed: 0 },
    createdByUid: opts.createdByUid,
    createdBy: opts.createdBy,
    createdAt: FieldValue.serverTimestamp() as unknown as null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    fanoutDone: false,
    ...(opts.approved ? { approved: opts.approved } : {}),
  };
  const startFanout = () =>
    publishCallback({
      retries: BROADCAST_FANOUT_RETRIES,
      pathname: "/api/broadcasts/email/fanout",
      body: { broadcastId: broadcastRef.id, cursor: null, slot: 0, territoryIds },
      delaySeconds: 0,
      deduplicationId: `bcastfan_${broadcastRef.id}_start`,
    });
  const failStart = async (): Promise<Failure> => {
    await broadcastRef.update({
      status: "failed",
      errorMessage: "Could not schedule the send. Check QStash and NEXT_PUBLIC_APP_URL.",
      completedAt: FieldValue.serverTimestamp(),
    });
    return { ok: false, status: 502, error: "Failed to schedule the broadcast. Check QStash configuration." };
  };

  try {
    await broadcastRef.create({ id: broadcastRef.id, ...broadcast });
  } catch (err) {
    if ((err as { code?: number }).code !== ALREADY_EXISTS) throw err;
    const existing = (await broadcastRef.get()).data() as BroadcastDoc | undefined;
    if (existing?.templateId !== templateId || JSON.stringify(existing.audienceFilter) !== JSON.stringify(audienceFilter)) {
      return { ok: false, status: 409, error: "This send was already submitted with different settings. Reopen the dialog and try again." };
    }
    if (existing.status === "failed") {
      return { ok: false, status: 502, error: existing.errorMessage ?? "This broadcast failed to start.", broadcastId: broadcastRef.id };
    }
    // The first attempt may have died before its fanout publish landed.
    if (existing.status === "queued" && existing.fanoutDone === false) {
      if (!(await startFanout())) return failStart();
    }
    return { ok: true, broadcastId: broadcastRef.id, duplicate: true };
  }
  if (!(await startFanout())) return failStart();
  return { ok: true, broadcastId: broadcastRef.id, duplicate: false };
}
