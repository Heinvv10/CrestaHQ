import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { isAssignableMember } from "@/lib/server/assignee";
import { checkBulkRateLimit } from "@/lib/contacts/bulk-rate-limit";
import { fireTagsAdded } from "@/lib/server/contacts-service";
import { mirrorContactAssignee } from "@/lib/server/conversation-mirror";
import {
  deleteContactServerSide,
  type ContactBlocker,
} from "@/lib/server/contact-delete";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { serializeContactForApi } from "@/lib/api/serializers/contacts";
import { runAfterResponse } from "@/lib/server/after-response";

type Mode = "live" | "test";

/**
 * POST /api/contacts/bulk — one action over a selection of contacts.
 *
 *   { subAccountId, ids: string[], action: { type, tag?, assignedToUid? } }
 *   type: "add_tag" | "remove_tag" | "assign" | "delete"
 *
 * Every id is verified to belong to `subAccountId` BEFORE anything is
 * written; one foreign (or unknown) id refuses the whole batch with 400 and
 * names the ids. A scoped collaborator may only act on contacts in their
 * territories (403 + ids otherwise). Delete is admin-only, like the single
 * route, and runs through the shared delete helper per contact so the
 * blocker check, submission sweep and cascade are identical.
 */

const MAX_IDS = 5000;
/** Firestore's batch limit is 500 writes; stay one under it. */
const BATCH = 499;

type Action =
  | { type: "add_tag" | "remove_tag"; tag: string }
  | { type: "assign"; assignedToUid: string | null }
  | { type: "delete" };

function parseAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "add_tag":
    case "remove_tag": {
      const tag = typeof a.tag === "string" ? a.tag.trim().slice(0, 100) : "";
      return tag ? { type: a.type, tag } : null;
    }
    case "assign": {
      if (a.assignedToUid === null) return { type: "assign", assignedToUid: null };
      if (typeof a.assignedToUid === "string" && a.assignedToUid.trim()) {
        return { type: "assign", assignedToUid: a.assignedToUid.trim() };
      }
      return null;
    }
    case "delete":
      return { type: "delete" };
    default:
      return null;
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const subAccountId = typeof body.subAccountId === "string" ? body.subAccountId : "";
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((x): x is string => typeof x === "string" && !!x))]
    : [];
  const action = parseAction(body.action);
  if (!subAccountId || ids.length === 0 || ids.length > MAX_IDS || !action) {
    return NextResponse.json(
      { error: "subAccountId, 1–5000 ids and a valid action are required" },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  // Counted after auth, per user, so an unauthenticated flood cannot lock
  // a real member out and a real member's loop is what gets dampened.
  const limit = checkBulkRateLimit(access.uid);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many bulk actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }
  const isAdmin =
    access.subAccountRole === "admin" || access.subAccountRole === "agencyOwner";
  if (action.type === "delete" && !isAdmin) {
    return NextResponse.json(
      { error: "Only sub-account admins can delete contacts." },
      { status: 403 },
    );
  }
  if (
    action.type === "assign" &&
    action.assignedToUid !== null &&
    !(await isAssignableMember(subAccountId, action.assignedToUid))
  ) {
    return NextResponse.json(
      { error: "assignedToUid is not a member of this sub-account" },
      { status: 400 },
    );
  }

  // --- verify every id before the first write -------------------------
  const db = getAdminDb();
  const refs = ids.map((id) => db.doc(`contacts/${id}`));
  const snaps: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += 500) {
    snaps.push(...(await db.getAll(...refs.slice(i, i + 500))));
  }
  const foreignIds = snaps
    .filter((s) => !s.exists || s.data()?.subAccountId !== subAccountId)
    .map((s) => s.id);
  if (foreignIds.length > 0) {
    return NextResponse.json(
      { error: "Some contacts are not in this sub-account", foreignIds },
      { status: 400 },
    );
  }
  const scope = await loadEffectiveTerritoryScope(access);
  if (scope.enforce) {
    const allowed = new Set(scope.ids ?? []);
    const deniedIds = snaps
      .filter((s) => !allowed.has((s.data()?.territoryId as string | null) ?? ""))
      .map((s) => s.id);
    if (deniedIds.length > 0) {
      return NextResponse.json(
        { error: "Some contacts aren't in one of your assigned territories.", deniedIds },
        { status: 403 },
      );
    }
  }

  // --- delete: per contact through the shared helper -------------------
  if (action.type === "delete") {
    let deleted = 0;
    const blocked: { id: string; blockers: ContactBlocker[] }[] = [];
    for (const snap of snaps) {
      const result = await deleteContactServerSide({ contactId: snap.id });
      if (result.status === "deleted") deleted++;
      else if (result.status === "blocked") blocked.push({ id: snap.id, blockers: result.blockers });
    }
    return NextResponse.json({ ok: true, deleted, blocked });
  }

  // --- tag / assign: batched field updates -----------------------------
  const updates: { snap: FirebaseFirestore.DocumentSnapshot; patch: Record<string, unknown> }[] = [];
  for (const snap of snaps) {
    const data = snap.data()!;
    if (action.type === "assign") {
      updates.push({ snap, patch: { assignedToUid: action.assignedToUid } });
      continue;
    }
    const before: string[] = Array.isArray(data.tags) ? data.tags : [];
    const tags =
      action.type === "add_tag"
        ? [...new Set([...before, action.tag])]
        : before.filter((t) => t !== action.tag);
    updates.push({ snap, patch: { tags } });
  }
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = db.batch();
    for (const { snap, patch } of updates.slice(i, i + BATCH)) {
      batch.update(snap.ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }

  // Owner mirror (SP2 T1) — the single-contact PATCH mirrors inside
  // updateContactServerSide; this route writes its own batch, so it mirrors
  // its own. Without it a bulk assign would leave the inbox scope filter
  // showing the old owner.
  // One query per contact, so run them 25 at a time — a 5000-contact
  // selection done one by one would outlast the request.
  if (action.type === "assign") {
    for (let i = 0; i < updates.length; i += 25) {
      await Promise.all(
        updates.slice(i, i + 25).map(({ snap }) =>
          mirrorContactAssignee({ contactId: snap.id, subAccountId })
        )
      );
    }
  }

  // Same announcements the single-contact update makes: contact.updated per
  // contact, and the tag-added trigger for the contacts that actually
  // gained the tag (fireTagsAdded diffs, so an already-tagged one is silent).
  for (const { snap, patch } of updates) {
    const data = snap.data()!;
    const mode = (data.mode as Mode) ?? "live";
    const merged = { ...data, ...patch };
    runAfterResponse(() => emitWebhookEvent({
      subAccountId,
      agencyId: data.agencyId as string,
      mode,
      type: "contact.updated",
      payload: { contact: serializeContactForApi(snap.id, merged, mode) },
    }));
    if (action.type === "add_tag") {
      runAfterResponse(() => fireTagsAdded({
        subAccountId,
        agencyId: data.agencyId as string,
        contactId: snap.id,
        mode,
        before: data.tags,
        after: patch.tags as string[],
      }));
    }
  }

  return NextResponse.json({ ok: true, updated: updates.length });
}
