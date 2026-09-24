import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { listPickableModels } from "@/lib/comms/ai/model-policy";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * The models this sub-account's AI Agents channels may pick: the agency
 * allow-list, under its price ceiling, still offered by OpenRouter. The app
 * default is returned separately — it is what "no override" means.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const agencyId = (saSnap.data() as SubAccountDoc | undefined)?.agencyId;
  if (!agencyId) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  return NextResponse.json(await listPickableModels(agencyId));
}
