import "server-only";

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import {
  BUYER_MAP_CONFIG_TAG,
  BUYER_MAP_DATA_TAG,
} from "@/lib/landing/buyer-map-cache";

/**
 * Agency-owner-only editor for the landing "Buyer World Map" section
 * (`appConfig/buyerWorldMap`). Read server-side by the landing page (cached,
 * tag-invalidated here) and live via the client hook on the editor preview;
 * written here through the Admin SDK (bypasses the `allow write: if false`
 * rule). Copy + toggle only — the buyer geography comes from the separate
 * cached aggregate.
 */

const DOC_PATH = "appConfig/buyerWorldMap";

interface PatchBody {
  enabled?: boolean;
  eyebrow?: string;
  headingLead?: string;
  headingEmphasis?: string;
  minCityBuyers?: number;
  showSavings?: boolean;
  annualSavingsPerBuyer?: number;
}

export async function PATCH(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: auth.uid,
  };

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "`enabled` must be a boolean." },
        { status: 400 },
      );
    }
    updates.enabled = body.enabled;
  }

  const strField = (
    key: "eyebrow" | "headingLead" | "headingEmphasis",
    max: number,
  ): NextResponse | void => {
    if (body[key] === undefined) return;
    const val = typeof body[key] === "string" ? body[key]!.trim() : "";
    if (!val || val.length > max) {
      return NextResponse.json(
        { error: `\`${key}\` must be 1–${max} characters.` },
        { status: 400 },
      );
    }
    updates[key] = val;
  };

  for (const [key, max] of [
    ["eyebrow", 80],
    ["headingLead", 120],
    ["headingEmphasis", 120],
  ] as const) {
    const err = strField(key, max);
    if (err) return err;
  }

  if (body.minCityBuyers !== undefined) {
    if (
      typeof body.minCityBuyers !== "number" ||
      !Number.isInteger(body.minCityBuyers) ||
      body.minCityBuyers < 1 ||
      body.minCityBuyers > 100
    ) {
      return NextResponse.json(
        { error: "`minCityBuyers` must be a whole number between 1 and 100." },
        { status: 400 },
      );
    }
    updates.minCityBuyers = body.minCityBuyers;
  }

  if (body.showSavings !== undefined) {
    if (typeof body.showSavings !== "boolean") {
      return NextResponse.json(
        { error: "`showSavings` must be a boolean." },
        { status: 400 },
      );
    }
    updates.showSavings = body.showSavings;
  }

  if (body.annualSavingsPerBuyer !== undefined) {
    if (
      typeof body.annualSavingsPerBuyer !== "number" ||
      !Number.isInteger(body.annualSavingsPerBuyer) ||
      body.annualSavingsPerBuyer < 0 ||
      body.annualSavingsPerBuyer > 10_000_000
    ) {
      return NextResponse.json(
        {
          error:
            "`annualSavingsPerBuyer` must be a whole number between 0 and 10,000,000.",
        },
        { status: 400 },
      );
    }
    updates.annualSavingsPerBuyer = body.annualSavingsPerBuyer;
  }

  // Require at least one real field beyond the two audit stamps.
  if (Object.keys(updates).length <= 2) {
    return NextResponse.json(
      { error: "No valid fields to update." },
      { status: 400 },
    );
  }

  try {
    await getAdminDb().doc(DOC_PATH).set(updates, { merge: true });
  } catch (err) {
    console.error("[agency/buyer-map-config] write failed", err);
    return NextResponse.json({ error: "Save failed." }, { status: 500 });
  }

  // Config drives the section's copy + visibility AND its minCityBuyers floor
  // (which changes the aggregate), so bust both caches — the public landing
  // reflects the edit within its normal revalidation window.
  revalidateTag(BUYER_MAP_CONFIG_TAG);
  revalidateTag(BUYER_MAP_DATA_TAG);

  return NextResponse.json({ ok: true });
}
