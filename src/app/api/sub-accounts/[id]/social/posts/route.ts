import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { publishSocialPost, qstashIsConfigured } from "@/lib/automations/qstash";
import { parsePostInput, scheduleRefusal } from "@/lib/social/post-rules";
import type {
  SocialPostDoc,
  SocialPostTargetResult,
  SubAccountDoc,
} from "@/types";

/**
 * Social Planner posts — per sub-account.
 *
 * GET  — list every post in the sub-account (member-readable; the calendar +
 *        list also stream over the client SDK).
 * POST — create a draft, or schedule a post to auto-publish at `scheduledAt`.
 *        Sub-account admin only. Gated on `socialPlannerEnabledByAgency`.
 *        Scheduling requires a connected Meta Page (and, for IG targets, a
 *        linked IG business account + image URL) and QStash configured.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .collection("socialPosts")
    .where("subAccountId", "==", subAccountId)
    .get();
  const posts = snap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<SocialPostDoc, "id">) }),
  );
  return NextResponse.json({ ok: true, posts });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;
  const agencyId = sub.agencyId;

  // Agency gate.
  if (sub.socialPlannerEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Social Planner is locked by your agency." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const parsed = parsePostInput(b);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { caption, imageUrl, targets } = parsed;
  const status = b.status === "scheduled" ? "scheduled" : "draft";
  if (status === "scheduled") {
    const refused = scheduleRefusal(parsed, sub, qstashIsConfigured());
    if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
  }

  // ── Validate schedule time ────────────────────────────────────────
  let scheduledAt: Date | null = null;
  let delaySeconds = 0;
  if (status === "scheduled") {
    const raw = typeof b.scheduledAt === "string" ? b.scheduledAt : "";
    const when = raw ? new Date(raw) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return NextResponse.json(
        { error: "Pick a valid date and time to schedule." },
        { status: 400 },
      );
    }
    // Allow a small clock-skew grace; otherwise must be in the future.
    const nowMs = Date.now();
    if (when.getTime() < nowMs - 60_000) {
      return NextResponse.json(
        { error: "Scheduled time must be in the future." },
        { status: 400 },
      );
    }
    scheduledAt = when;
    delaySeconds = Math.max(0, Math.floor((when.getTime() - nowMs) / 1000));
  }

  // ── Write the doc (id first, so the QStash body can reference it) ──
  const ref = db.collection("socialPosts").doc();
  const results: SocialPostTargetResult[] = targets.map((platform) => ({
    platform,
    status: "pending",
    externalId: null,
    error: null,
  }));

  let qstashMessageId: string | null = null;
  if (status === "scheduled") {
    const scheduled = await publishSocialPost({
      postId: ref.id,
      subAccountId,
      delaySeconds,
    });
    if (!scheduled) {
      return NextResponse.json(
        { error: "Couldn't schedule the post. Please try again." },
        { status: 502 },
      );
    }
    qstashMessageId = scheduled.messageId;
  }

  const now = FieldValue.serverTimestamp();
  const docPayload: Omit<SocialPostDoc, "id"> = {
    agencyId,
    subAccountId,
    createdByUid: access.uid,
    caption,
    imageUrl,
    targets,
    status,
    // Admin SDK persists a JS Date as a Firestore Timestamp; the doc type
    // models the read shape (Timestamp), hence the cast.
    scheduledAt: (scheduledAt ??
      null) as unknown as SocialPostDoc["scheduledAt"],
    publishedAt: null,
    results,
    qstashMessageId,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(docPayload);

  return NextResponse.json({ ok: true, id: ref.id, status });
}
