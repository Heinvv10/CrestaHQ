import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { emailIsConfigured } from "@/lib/comms/resend";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { resolveMergeTags, validateEmailBody } from "@/lib/automations/merge-tags";
import { countAudience } from "@/lib/broadcasts/audience";
import { BROADCAST_FANOUT_RETRIES } from "@/lib/broadcasts/completion";
import type {
  BroadcastAudienceFilter,
  BroadcastDoc,
  MessageTemplateDoc,
} from "@/types";

export const dynamic = "force-dynamic";

interface SendBody {
  subAccountId?: string;
  templateId?: string;
  audienceFilter?: BroadcastAudienceFilter;
  /** Client-generated per submit; a retry with the same key is a no-op. */
  idempotencyKey?: string;
}

/** Hard cap on per-broadcast audience size to prevent runaway sends. */
const MAX_AUDIENCE_SIZE = 25_000;

/** gRPC ALREADY_EXISTS — create() on a doc that is already there. */
const ALREADY_EXISTS = 6;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured — bulk send needs the queue." },
      { status: 503 },
    );
  }

  let payload: SendBody;
  try {
    payload = (await request.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = payload.subAccountId?.trim();
  const templateId = payload.templateId?.trim();
  const audienceFilter = payload.audienceFilter;

  const idempotencyKey = payload.idempotencyKey;

  if (!subAccountId || !templateId || !audienceFilter) {
    return NextResponse.json(
      { error: "subAccountId, templateId, and audienceFilter are required" },
      { status: 400 },
    );
  }
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return NextResponse.json(
      { error: "idempotencyKey (8-64 chars of A-Z, a-z, 0-9, _ or -) is required" },
      { status: 400 },
    );
  }
  if (
    audienceFilter.kind !== "all" &&
    audienceFilter.kind !== "tag" &&
    audienceFilter.kind !== "pipeline_stage"
  ) {
    return NextResponse.json(
      { error: "audienceFilter.kind must be 'all', 'tag', or 'pipeline_stage'" },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();

  // Agency-level gate. Sub-account admins can't bypass — the field is
  // server-set via the agency owner's Manage dialog. Default-deny on
  // missing field so legacy sub-accounts stay locked until the agency
  // owner explicitly enables broadcasts.
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json(
      { error: "Sub-account not found" },
      { status: 404 },
    );
  }
  if (subSnap.data()?.broadcastsEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "Broadcasts are disabled for this sub-account. Your agency administrator can enable them from Manage in the agency sub-accounts list.",
      },
      { status: 403 },
    );
  }

  if (!emailIsConfigured(subSnap.data())) {
    return NextResponse.json(
      { error: "Email is not configured for this sub-account." },
      { status: 503 },
    );
  }
  // Validate template — must exist, must be email, must contain unsubscribeLink.
  const templateSnap = await db
    .collection("message_templates")
    .doc(templateId)
    .get();
  if (!templateSnap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  const template = templateSnap.data() as MessageTemplateDoc;
  if (template.subAccountId !== subAccountId) {
    return NextResponse.json(
      { error: "Template belongs to a different sub-account" },
      { status: 403 },
    );
  }
  if (template.type !== "email") {
    return NextResponse.json(
      { error: "Template is not an email template" },
      { status: 400 },
    );
  }
  const bodyValidation = validateEmailBody(template.body);
  if (bodyValidation) {
    return NextResponse.json({ error: bodyValidation }, { status: 400 });
  }

  // A scoped collaborator only reaches contacts in their assigned
  // territories; admins / owners / scoping-off pass null. Applied before
  // counting, and carried to the fanout step in the (signed) QStash body.
  const scope = await loadEffectiveTerritoryScope(access);
  const territoryIds = scope.enforce ? (scope.ids ?? []) : null;

  // Size the audience without reading it — the contacts themselves are read
  // page by page in the fanout step, never whole inside this request. The
  // count is pre-skip (opted-out / no-email contacts included), so the cap
  // errs on the side of refusing.
  const matching = await countAudience(
    subAccountId,
    audienceFilter,
    territoryIds,
    MAX_AUDIENCE_SIZE,
  );
  if (matching === 0) {
    return NextResponse.json(
      { error: "Audience is empty — no contacts match this filter." },
      { status: 400 },
    );
  }
  if (matching > MAX_AUDIENCE_SIZE) {
    return NextResponse.json(
      {
        error: `Audience size exceeds the per-broadcast cap of ${MAX_AUDIENCE_SIZE}. Narrow the filter and try again.`,
      },
      { status: 400 },
    );
  }

  // Snapshot the trigger user's display name for the broadcast doc.
  let createdByName = access.email;
  try {
    const u = await getAdminAuth().getUser(access.uid);
    createdByName = u.displayName || u.email || access.email;
  } catch {
    // Fall through with the email as the display name.
  }

  // Pre-render the subject for the broadcast list view. Uses an empty
  // contact context — merge tags in the subject still work for the per-send
  // pass; this is just a label.
  const subjectPreview = (template.subject ?? "")
    .slice(0, 200);

  const agencyId = templateSnap.data()?.agencyId as string;
  // The idempotency key names the doc, so a retried or double-clicked submit
  // lands on the same broadcast instead of starting a second one.
  const broadcastRef = db
    .collection("broadcasts")
    .doc(`${subAccountId}_${idempotencyKey}`);

  const broadcast: Omit<BroadcastDoc, "id"> = {
    agencyId,
    subAccountId,
    channel: "email",
    templateId,
    templateName: template.name,
    subjectPreview: resolveMergeTags(subjectPreview, {
      contact: { name: "", email: "", phone: "" },
      owner: { displayName: "", email: "" },
      workspace: { name: "" },
      bookingLink: "",
      unsubscribeLink: "",
    }),
    audienceFilter,
    status: "queued",
    // Filled in page by page by the fanout step.
    totals: { audienceSize: 0, queued: 0, sent: 0, skipped: 0, failed: 0 },
    createdByUid: access.uid,
    createdBy: { displayName: createdByName, email: access.email },
    createdAt: FieldValue.serverTimestamp() as unknown as null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    fanoutDone: false,
  };
  // Fixed dedup id: a re-publish on retry collapses into the first.
  const startFanout = () =>
    publishCallback({
      retries: BROADCAST_FANOUT_RETRIES,
      pathname: "/api/broadcasts/email/fanout",
      body: { broadcastId: broadcastRef.id, cursor: null, slot: 0, territoryIds },
      delaySeconds: 0,
      deduplicationId: `bcastfan_${broadcastRef.id}_start`,
    });
  // publishCallback never throws: null = the fanout was not queued.
  const failStart = async () => {
    await broadcastRef.update({
      status: "failed",
      errorMessage: "Could not schedule the send. Check QStash and NEXT_PUBLIC_APP_URL.",
      completedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json(
      { error: "Failed to schedule the broadcast. Check QStash configuration." },
      { status: 502 },
    );
  };

  try {
    await broadcastRef.create({ id: broadcastRef.id, ...broadcast });
  } catch (err) {
    if ((err as { code?: number }).code !== ALREADY_EXISTS) throw err;
    const existing = (await broadcastRef.get()).data() as BroadcastDoc | undefined;
    if (
      existing?.templateId !== templateId ||
      JSON.stringify(existing.audienceFilter) !== JSON.stringify(audienceFilter)
    ) {
      return NextResponse.json(
        { error: "This send was already submitted with different settings. Reopen the dialog and try again." },
        { status: 409 },
      );
    }
    if (existing.status === "failed") {
      return NextResponse.json(
        { error: existing.errorMessage ?? "This broadcast failed to start.", broadcastId: broadcastRef.id },
        { status: 502 },
      );
    }
    // The first attempt may have died before its fanout publish landed.
    if (existing.status === "queued" && existing.fanoutDone === false) {
      if (!(await startFanout())) return failStart();
    }
    return NextResponse.json({
      ok: true,
      broadcastId: broadcastRef.id,
      audienceSize: matching,
      duplicate: true,
    });
  }

  // Hand the audience to the fanout step, which pages through it and
  // publishes the staggered per-recipient sends.
  const fanout = await startFanout();
  if (!fanout) return failStart();

  return NextResponse.json({
    ok: true,
    broadcastId: broadcastRef.id,
    audienceSize: matching,
  });
}
