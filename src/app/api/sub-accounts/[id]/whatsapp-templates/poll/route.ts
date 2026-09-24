import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import {
  fetchApprovalStatus,
  WhatsappContentError,
} from "@/lib/comms/whatsapp/templates-api";
import { resolveWhatsappSender } from "@/lib/comms/whatsapp/resolve-sender";
import {
  buildRegistrationUpdate,
  classifyPollTick,
} from "@/lib/comms/whatsapp/template-registrations";
import { getWabaCreds } from "@/lib/comms/whatsapp/cloud-credentials";
import {
  fetchCloudTemplateStatus,
  CloudTemplateError,
} from "@/lib/comms/whatsapp/cloud-templates";
import type { SubAccountDoc } from "@/types";
import type {
  WhatsappTemplateDoc,
  WhatsappTemplateStatus,
} from "@/types/whatsapp-templates";
import { readSubAccountSecret } from "@/lib/server/sub-account-secrets";

export const dynamic = "force-dynamic";

/**
 * QStash callback that polls Twilio for a template's WhatsApp approval status.
 * Mirrors the website-builder poll, with a backoff tail: tight 20s polling
 * for the first ~5 minutes (approvals are usually quick), then 5-minute ticks
 * out to a few hours, since Meta can occasionally take longer. At the cap we
 * stop and leave the template "pending" (re-submitting re-arms the poll).
 */

const FAST_INTERVAL_SECONDS = 20;
const SLOW_INTERVAL_SECONDS = 300;
const FAST_ATTEMPTS = 15; // ~5 min at 20s
const MAX_POLL_ATTEMPTS = 60; // ~5 min + ~3.75h

interface PollPayload {
  subAccountId?: string;
  templateId?: string;
  contentSid?: string;
}

function delayForAttempt(attempt: number): number {
  return attempt < FAST_ATTEMPTS ? FAST_INTERVAL_SECONDS : SLOW_INTERVAL_SECONDS;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;

  if (!qstashIsConfigured()) {
    return NextResponse.json({ error: "QStash is not configured." }, { status: 503 });
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Upstash-Signature header" }, { status: 401 });
  }
  const rawBody = await request.text();
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: PollPayload;
  try {
    payload = JSON.parse(rawBody) as PollPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (
    payload.subAccountId !== subAccountId ||
    typeof payload.templateId !== "string" ||
    typeof payload.contentSid !== "string"
  ) {
    return NextResponse.json(
      { error: "Body must include subAccountId + templateId + contentSid" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${subAccountId}/whatsappTemplates/${payload.templateId}`,
  );
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ ok: true, ignored: "doc-missing" });
  }
  const tpl = snap.data() as WhatsappTemplateDoc;

  const subSnap0 = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap0.exists ? (subSnap0.data() as SubAccountDoc) : null;
  // The same resolution the submit route ran, so a poll chases the approval on
  // the rail the template was actually submitted to.
  const resolvedSender = resolveWhatsappSender(sub);
  if (!resolvedSender.ok) {
    // No rail, so there is nothing to compare the registration against. Every
    // branch below is keyed on the provider, and guessing one makes
    // `classifyPollTick` read the WRONG rail's registration, report
    // "rail-switched", and park the template as `failed` with a reason that is
    // not true.
    //
    // The comment below explains why a tick that gives up is dangerous: it can
    // strand a template in `pending`, which the UI cannot escape. That still
    // applies — this tick ends the poll chain — but it is the lesser harm,
    // because it writes NOTHING. The template keeps whatever state it really
    // has, and the cure is fixing the sender configuration and re-submitting,
    // which re-arms the poll. A terminal state written on a guess has no cure.
    console.warn(
      `[whatsapp-templates/poll] no resolvable WhatsApp sender for sa=${subAccountId} (${resolvedSender.error}) — leaving template ${payload.templateId} untouched`,
    );
    return NextResponse.json({ ok: true, ignored: "sender-unresolved" });
  }
  const { provider } = resolvedSender;

  // Bail if we're no longer chasing this approval — re-submitted with a new
  // external id, switched rails since the tick was scheduled, or already
  // settled. Compared against the ACTIVE rail's registration, not the flat
  // contentSid, which on a cloud workspace is a UI mirror rather than the id
  // this poll is tracking.
  // `pending` is a state the UI cannot escape (submit takes only
  // draft/rejected/failed; delete refuses pending), so a tick that simply
  // gives up would strand the template permanently. See classifyPollTick.
  const tick = classifyPollTick(tpl, provider, payload.contentSid);
  if (tick === "rail-switched") {
    // The workspace changed providers mid-approval. Park it as `failed`, which
    // IS re-submittable, and say why. The other rail's registration is left
    // intact — that approval is still real, it just is not the rail this
    // workspace sends on any more.
    await ref.update({
      status: "failed",
      rejectionReason: `This workspace switched its WhatsApp provider to ${provider} while the template was awaiting approval. Re-submit it to get approval on the ${provider} rail.`,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, settled: "rail-switched" });
  }
  if (tick === "stale") {
    return NextResponse.json({ ok: true, ignored: "stale-tick" });
  }

  const attempts = (tpl.pollAttempts ?? 0) + 1;
  if (attempts > MAX_POLL_ATTEMPTS) {
    // Leave it pending — Meta may still decide. The operator can re-submit to
    // re-arm the poll. Record the attempt so the UI can show "still pending".
    await ref.update({
      pollAttempts: attempts,
      lastSyncedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: true, settled: "timeout" });
  }

  let result: { status: WhatsappTemplateStatus; rejectionReason: string | null };
  try {
    if (provider === "cloud") {
      const creds = await getWabaCreds(subAccountId);
      const cloud = await fetchCloudTemplateStatus(creds, tpl.name);
      if (!cloud) {
        // Meta does not list the name yet. A just-submitted template can be
        // briefly absent, so keep waiting rather than declaring it failed.
        await ref.update({
          pollAttempts: attempts,
          lastSyncedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return reschedule(ref, subAccountId, payload.templateId, payload.contentSid, attempts, "not-listed");
      }
      result = { status: cloud.status, rejectionReason: cloud.reason };
    } else {
      const cfg = sub?.twilioConfig ?? null;
      const authToken = cfg ? await readSubAccountSecret(subAccountId, "twilio", cfg) : "";
      if (!cfg?.accountSid || !authToken) {
        // Creds disappeared — stop chasing.
        await ref.update({
          status: "failed",
          rejectionReason: "Twilio credentials are no longer configured.",
          pollAttempts: attempts,
          updatedAt: FieldValue.serverTimestamp(),
        });
        return NextResponse.json({ ok: true, settled: "no-creds" });
      }
      const twilio = await fetchApprovalStatus({
        accountSid: cfg.accountSid,
        authToken,
        contentSid: payload.contentSid,
      });
      result = {
        status: twilio.status as WhatsappTemplateStatus,
        rejectionReason: twilio.rejectionReason,
      };
    }
  } catch (err) {
    // 4xx = terminal (content gone / bad request); 5xx + network = retry.
    const clientError =
      (err instanceof WhatsappContentError || err instanceof CloudTemplateError) &&
      err.status >= 400 &&
      err.status < 500;
    if (clientError) {
      await ref.update({
        status: "failed",
        rejectionReason: `Approval lookup failed: ${err instanceof Error ? err.message : "unknown"}`,
        pollAttempts: attempts,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({ ok: true, settled: "client-error" });
    }
    console.warn("[whatsapp-templates/poll] status fetch threw — rescheduling", err);
    await ref.update({
      pollAttempts: attempts,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return reschedule(ref, subAccountId, payload.templateId, payload.contentSid, attempts, "transient");
  }

  // Terminal states. Recorded against the rail that was polled, so an approval
  // on one rail never reads as approval on the other.
  const TERMINAL: ReadonlyArray<WhatsappTemplateStatus> = [
    "approved",
    "rejected",
    "paused",
    "disabled",
  ];
  if (TERMINAL.includes(result.status)) {
    await ref.update({
      ...buildRegistrationUpdate(tpl, provider, {
        externalId: payload.contentSid,
        status: result.status,
        rejectionReason:
          result.status === "rejected" ? result.rejectionReason : null,
        pollAttempts: attempts,
        // Stamped per rail as well as flat. The flat field is a single global
        // value, so a later approval on the other rail overwrites it — the
        // per-rail copy is the one that stays true.
        // serverTimestamp(), matching the flat field written below — two
        // mechanisms for what is meant to be the same instant would drift by
        // however long the request took.
        ...(result.status === "approved"
          ? { approvedAt: FieldValue.serverTimestamp() }
          : {}),
      }),
      pollAttempts: attempts,
      lastSyncedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(result.status === "approved"
        ? { approvedAt: FieldValue.serverTimestamp() }
        : {}),
    });
    return NextResponse.json({ ok: true, settled: result.status });
  }

  // Still pending (or unknown — treat as pending). Bump + reschedule.
  await ref.update({
    pollAttempts: attempts,
    lastSyncedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return reschedule(ref, subAccountId, payload.templateId, payload.contentSid, attempts, "pending");
}

/**
 * Queue the next tick. publishCallback never throws: null means it was not
 * queued (e.g. the daily cap). With no tick coming, `pending` would be
 * stranded, so park the template as `failed` (re-submittable) and say why.
 */
async function reschedule(
  ref: FirebaseFirestore.DocumentReference,
  subAccountId: string,
  templateId: string,
  contentSid: string,
  attempts: number,
  deferred: string,
): Promise<NextResponse> {
  const queued = await publishCallback({
    pathname: `/api/sub-accounts/${subAccountId}/whatsapp-templates/poll`,
    body: { subAccountId, templateId, contentSid },
    delaySeconds: delayForAttempt(attempts),
    deduplicationId: `watpl_${subAccountId}_${templateId}_${attempts}`,
  });
  if (queued) return NextResponse.json({ ok: true, deferred });
  console.error(`[whatsapp-templates/poll] next poll not queued sa=${subAccountId} template=${templateId}`);
  await ref.update({
    status: "failed",
    rejectionReason: "Could not schedule the next approval check. Re-submit the template to retry.",
    updatedAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true, settled: "unscheduled" });
}
