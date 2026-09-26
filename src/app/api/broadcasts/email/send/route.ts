import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { checkBroadcast, startBroadcast } from "@/lib/server/broadcast-start";
import type { BroadcastAudienceFilter } from "@/types";

export const dynamic = "force-dynamic";

interface SendBody {
  subAccountId?: string;
  templateId?: string;
  audienceFilter?: BroadcastAudienceFilter;
  /** Client-generated per submit; a retry with the same key is a no-op. */
  idempotencyKey?: string;
}

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

  const scope = await loadEffectiveTerritoryScope(access);
  const territoryIds = scope.enforce ? (scope.ids ?? []) : null;

  const checked = await checkBroadcast({ subAccountId, templateId, audienceFilter, territoryIds });
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: checked.status });
  }
  const { template, matching } = checked;

  // Snapshot the trigger user's display name so the history table shows a
  // stable name even if the user is later deleted.
  let createdByName = access.email;
  try {
    const u = await getAdminAuth().getUser(access.uid);
    createdByName = u.displayName || u.email || access.email;
  } catch {
    // Fall through with email as the name; never block a send on this.
  }

  const started = await startBroadcast({
    subAccountId,
    idempotencyKey,
    templateId,
    template,
    audienceFilter,
    territoryIds,
    createdByUid: access.uid,
    createdBy: { displayName: createdByName, email: access.email },
  });
  if (!started.ok) {
    return NextResponse.json(
      { error: started.error, ...(started.broadcastId ? { broadcastId: started.broadcastId } : {}) },
      { status: started.status },
    );
  }
  return NextResponse.json({
    ok: true,
    broadcastId: started.broadcastId,
    audienceSize: matching,
    ...(started.duplicate ? { duplicate: true } : {}),
  });
}
