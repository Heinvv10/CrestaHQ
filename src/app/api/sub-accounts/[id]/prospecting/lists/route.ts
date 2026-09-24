import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { GET_LEADS_RESULT_LIMIT } from "@/lib/get-leads/business-types";
import { prospectingEnabled, prospectingGateOff } from "@/lib/prospecting/gate";
import type { ProspectListQuery, SubAccountDoc } from "@/types";

/**
 * Saved prospect lists — one per Get Leads result set the operator saves.
 *
 *   GET  → this sub-account's lists, newest first.
 *   POST → `{ name, query, count }` creates a `prospectLists` doc; returns its id.
 *
 * Any active member (or the agency owner). Both answer 403 `gate_off` while
 * `prospectingEnabledByAgency` is not `true`. Equality-only query plus an
 * in-memory sort, so no composite index.
 */

type Access = { uid: string; agencyId: string };

async function gatedAccess(
  request: Request,
  subAccountId: string,
): Promise<Access | NextResponse> {
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = (snap.data() ?? {}) as SubAccountDoc;
  if (!prospectingEnabled(sub)) return prospectingGateOff();
  return { uid: access.uid, agencyId: sub.agencyId };
}

const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
};

function parseQuery(v: unknown): ProspectListQuery | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const q = v as Record<string, unknown>;
  const businessType = text(q.businessType, 100);
  // Empty when the search was anchored on "Use my location".
  const placeName = typeof q.placeName === "string" ? q.placeName.trim() : null;
  if (!businessType || placeName === null || placeName.length > 200) return null;
  if (!finite(q.lat, -90, 90) || !finite(q.lng, -180, 180)) return null;
  if (!finite(q.radiusKm, 0, 50) || q.radiusKm === 0) return null;
  return { businessType, placeName, lat: q.lat, lng: q.lng, radiusKm: q.radiusKm };
}

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  const ts = v as { toDate?: () => Date } | null;
  return typeof ts?.toDate === "function" ? ts.toDate().toISOString() : null;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await gatedAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb()
    .collection("prospectLists")
    .where("subAccountId", "==", subAccountId)
    .get();
  const lists = snap.docs
    .map((d) => {
      const data = d.data() ?? {};
      return {
        id: d.id,
        name: data.name as string,
        query: data.query as ProspectListQuery,
        count: data.count as number,
        createdAt: toIso(data.createdAt),
      };
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return NextResponse.json({ lists });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await gatedAccess(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = text(body?.name, 100);
  if (!name) {
    return NextResponse.json(
      { error: "Give the list a name (up to 100 characters)." },
      { status: 400 },
    );
  }
  const query = parseQuery(body.query);
  if (!query) {
    return NextResponse.json(
      { error: "The list's search (business type, place, location, radius up to 50 km) is invalid." },
      { status: 400 },
    );
  }
  const count = body.count;
  if (!Number.isInteger(count) || !finite(count, 0, GET_LEADS_RESULT_LIMIT)) {
    return NextResponse.json(
      { error: `count must be a whole number from 0 to ${GET_LEADS_RESULT_LIMIT}.` },
      { status: 400 },
    );
  }

  const ref = await getAdminDb().collection("prospectLists").add({
    agencyId: access.agencyId,
    subAccountId,
    createdByUid: access.uid,
    name,
    query,
    count,
    createdAt: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true, id: ref.id });
}
