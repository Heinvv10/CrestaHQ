import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  BUSINESS_TYPES,
  GET_LEADS_CUSTOM_TYPE_MAX_LEN,
  GET_LEADS_MAX_CUSTOM_TYPES,
  slugifyBusinessType,
} from "@/lib/get-leads/business-types";
import type { SubAccountDoc } from "@/types";

/**
 * Get Leads — manage the sub-account's custom service types (the operator-
 * defined additions to the curated business-type picklist).
 *
 * PUT replaces the whole list (the manage dialog edits locally and saves
 * once) — add/update/remove are all "send the new list". Admin-only: the
 * saved labels become part of the search-route query allowlist, i.e. they
 * spend the agency's Outscraper credits, so collaborators can use them but
 * not mint them.
 */

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() as SubAccountDoc;

  if (sub.getLeadsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Get Leads is locked by your agency." },
      { status: 403 },
    );
  }

  let body: { types?: unknown; hidden?: unknown };
  try {
    body = (await request.json()) as { types?: unknown; hidden?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.types)) {
    return NextResponse.json(
      { error: "`types` must be an array of service names." },
      { status: 400 },
    );
  }

  // Curated entries the operator deleted from their picker. Presentation-only
  // (the search allowlist still accepts curated values); validated against the
  // real curated values so junk can't accumulate on the doc.
  const curatedValues = new Set(BUSINESS_TYPES.map((t) => t.value));
  const hidden = Array.isArray(body.hidden)
    ? [...new Set(
        body.hidden.filter(
          (v): v is string => typeof v === "string" && curatedValues.has(v),
        ),
      )]
    : [];

  // Sanitize + dedupe (case-insensitive by slug, so "Vegan Bakery" and
  // "vegan bakery" can't coexist).
  const seen = new Set<string>();
  const types: string[] = [];
  for (const raw of body.types) {
    if (typeof raw !== "string") continue;
    const label = raw.replace(/[\r\n\t]/g, " ").trim().slice(0, GET_LEADS_CUSTOM_TYPE_MAX_LEN);
    if (label.length < 2) continue;
    const slug = slugifyBusinessType(label);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    types.push(label);
  }
  if (types.length > GET_LEADS_MAX_CUSTOM_TYPES) {
    return NextResponse.json(
      { error: `At most ${GET_LEADS_MAX_CUSTOM_TYPES} custom service types.` },
      { status: 400 },
    );
  }

  await subRef.update({
    getLeadsCustomTypes: types,
    getLeadsHiddenTypes: hidden,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, types, hidden });
}
