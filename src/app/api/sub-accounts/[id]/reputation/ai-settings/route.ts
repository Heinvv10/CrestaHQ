import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { gbpRefusal } from "@/lib/gbp/route-support";

/**
 * PUT /api/sub-accounts/[id]/reputation/ai-settings `{replyGuidelines}` —
 * the reply guidelines the AI DRAFT follows (tone, sign-off, things never to
 * say; SP5 c, ledger R6). Sub-account admin, the agency's Reviews AI gate
 * (403 `ai_gate_off`). At most 1000 characters, stored trimmed ("" clears
 * them); any other key — an auto-reply switch included — is 400
 * `invalid_body`: there is no auto-reply. Written to
 * `subAccounts/{id}.reviewsAiConfig` (member-readable, server-written).
 */

export const dynamic = "force-dynamic";

const MAX_GUIDELINES_CHARS = 1000;

const invalid = () => gbpRefusal(400, "invalid_body", `Guidelines must be text of at most ${MAX_GUIDELINES_CHARS} characters.`);

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;
  const ref = getAdminDb().doc(`subAccounts/${id}`);
  if ((await ref.get()).data()?.reviewsAiEnabledByAgency !== true) {
    return gbpRefusal(403, "ai_gate_off", "Reviews AI is not enabled for this sub-account.");
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
  const keys = Object.keys(body);
  const raw = (body as { replyGuidelines?: unknown }).replyGuidelines;
  if (keys.length !== 1 || keys[0] !== "replyGuidelines" || typeof raw !== "string") return invalid();
  const replyGuidelines = raw.trim();
  if (replyGuidelines.length > MAX_GUIDELINES_CHARS) return invalid();

  const updatedAt = new Date();
  await ref.set({ reviewsAiConfig: { replyGuidelines, updatedAt, updatedByUid: access.uid } }, { merge: true });
  return NextResponse.json({ reviewsAiConfig: { replyGuidelines, updatedAt: updatedAt.toISOString() } });
}
