import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import type { SubAccountDoc } from "@/types";
import { WabaNotConfiguredError } from "../cloud-credentials";
import { getWhatsappSettingsProviderFor } from "./select";
import { WaSettingsError, type WhatsappSettingsProvider } from "./types";

/**
 * The prologue every `/api/sub-accounts/[id]/whatsapp/*` route shares:
 * tenancy (member for reads, admin for writes), the agency's WhatsApp gate,
 * then the provider for THIS path's sub-account. Errors map the same way
 * everywhere — no connection → 409 `not_connected`; a provider failure →
 * its status, clamped to 400–502 so a Meta 5xx can never read as ours.
 * Never returns a credential.
 */

export const GATE_OFF_MESSAGE =
  "WhatsApp isn't enabled for this workspace. Ask your agency to turn it on.";

export interface WaSettingsContext {
  subAccountId: string;
  sub: SubAccountDoc;
  provider: WhatsappSettingsProvider;
}

export async function withWhatsappSettings(
  request: Request,
  subAccountId: string,
  level: "member" | "admin",
  fn: (ctx: WaSettingsContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const access =
    level === "admin"
      ? await requireSubAccountAdmin(request, subAccountId)
      : await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = snap.exists ? (snap.data() as SubAccountDoc) : null;
  if (!sub) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (sub.whatsappEnabledByAgency !== true) {
    return NextResponse.json({ error: GATE_OFF_MESSAGE }, { status: 403 });
  }
  // The connection check the PAGE makes, applied here too: a workspace
  // without a Cloud number is "not connected" in fake mode as well, where no
  // credential read would otherwise refuse it.
  if (!sub.whatsappCloudMeta?.phoneNumberId) {
    return NextResponse.json({ error: "not_connected" }, { status: 409 });
  }

  let provider: WhatsappSettingsProvider;
  try {
    provider = await getWhatsappSettingsProviderFor(subAccountId);
  } catch (err) {
    if (err instanceof WabaNotConfiguredError) {
      return NextResponse.json({ error: "not_connected" }, { status: 409 });
    }
    throw err;
  }

  try {
    return await fn({ subAccountId, sub, provider });
  } catch (err) {
    if (err instanceof WaSettingsError) {
      return NextResponse.json(
        { error: err.message },
        { status: Math.min(502, Math.max(400, err.status)) },
      );
    }
    throw err;
  }
}

/** Parse a JSON body, or answer 400. */
export async function readJson(request: Request): Promise<unknown | NextResponse> {
  try {
    return await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}
