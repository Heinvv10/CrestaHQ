import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { unsubscribePageFromWebhook } from "@/lib/comms/meta";
import type { SubAccountDoc } from "@/types";
import { readSubAccountSecret, subAccountSecretPath } from "@/lib/server/sub-account-secrets";

/**
 * Disconnect the BETA Facebook/Instagram inbox for a sub-account.
 *
 *   DELETE /api/sub-accounts/[id]/meta
 *
 * Sub-account admin only. Best-effort unsubscribes the Page from our webhook,
 * then clears `metaConfig`. No message history is touched. Re-connecting is a
 * fresh OAuth pass.
 */

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const snap = await db.doc(`subAccounts/${id}`).get();
  const sa = snap.exists ? (snap.data() as SubAccountDoc) : null;
  const cfg = sa?.metaConfig ?? null;

  const pageAccessToken = cfg ? await readSubAccountSecret(id, "meta", cfg) : "";
  if (cfg?.pageId && pageAccessToken) {
    try {
      await unsubscribePageFromWebhook(cfg.pageId, pageAccessToken);
    } catch (err) {
      console.warn(`[meta/disconnect] unsubscribe failed sa=${id}`, err);
    }
  }

  const batch = db.batch();
  batch.update(db.doc(`subAccounts/${id}`), {
    metaConfig: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.delete(db.doc(subAccountSecretPath(id, "meta")));
  await batch.commit();

  return NextResponse.json({ ok: true });
}
