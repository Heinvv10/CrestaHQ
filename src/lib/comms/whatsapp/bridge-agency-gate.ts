import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";

/**
 * The agency feature gate every self-serve bridge route stands behind.
 *
 * `whatsappEnabledByAgency` is the agency's switch for this workspace (see
 * docs/architecture/feature-gates.md, which makes the runtime 403 a required
 * step of the pattern). It is checked here, in ONE place, because the routes it
 * guards hand out device-linking credentials: the pairing round, the QR that
 * encodes it, and the restart that mints a fresh batch of codes. Four copies of
 * this check would be four chances for one of them to drift open, and a gate
 * that is open on one route is open.
 *
 * The DELETE on the base bridge route is deliberately NOT behind this — see the
 * comment there.
 *
 * Returns the sub-account on success so callers that need the document (the
 * display name, say) do not read it twice.
 */
export type AgencyGate =
  | { ok: true; sub: SubAccountDoc }
  | { ok: false; response: NextResponse };

export async function requireWhatsappEnabledByAgency(
  subAccountId: string,
): Promise<AgencyGate> {
  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sub) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Sub-account not found" },
        { status: 404 },
      ),
    };
  }
  if (sub.whatsappEnabledByAgency !== true) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "WhatsApp isn't enabled for this workspace. Ask your agency to turn it on.",
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true, sub };
}
